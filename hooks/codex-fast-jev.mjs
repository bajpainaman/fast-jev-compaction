#!/usr/bin/env node
// Codex SessionStart(compact) hook: after native compaction, restore the
// tool results Jev scores as still needed, as additionalContext.
//
// Codex hooks cannot replace compaction history (see CODEX.md), so the native
// summary stands; this adds back the verbatim excerpts worth keeping. Any
// failure exits 0 with no output so session start is never blocked.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compactCodexItems, JevClient } from '../dist/index.js';

function resolveApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8');
    const match = env.match(/^KEY='?([^'\n]+)'?$/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

const MAX_CONTEXT_CHARS = 30_000;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_ARGS_CHARS = 500;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return undefined;
  }
}

function rolloutItems(path) {
  const items = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === 'response_item' && record.payload?.type) items.push(record.payload);
  }
  return items;
}

function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[… ${text.length - limit} chars clipped …]`;
}

// Re-injecting opaque bytes (Fernet-encrypted subagent payloads, raw base64
// dumps) wastes the budget: the model cannot read them and they crowd out
// legible results. Skip a pair whose output is dominated by such a blob.
function looksOpaque(text) {
  if (text.startsWith('gAAAAA')) return true; // Fernet token
  const longest = (text.match(/\S{200,}/g) ?? []).reduce((a, s) => Math.max(a, s.length), 0);
  if (longest === 0) return false;
  const b64 = (text.match(/[A-Za-z0-9+/_=-]/g) ?? []).length / text.length;
  return longest >= 400 && b64 > 0.9;
}

function fakeAsker() {
  return {
    async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 1 }])) };
    },
  };
}

function trace(...args) {
  if (process.env.FAST_JEV_DEBUG === '1') console.error('[fast-jev]', ...args);
}

async function main() {
  const event = readStdin();
  trace('event', event?.hook_event_name, event?.source, event?.transcript_path);
  if (event?.hook_event_name !== 'SessionStart' || event?.source !== 'compact') return;
  const transcript = event.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return;
  const dry = process.env.FAST_JEV_DRY === '1';
  const apiKey = dry ? undefined : resolveApiKey();
  if (!dry && !apiKey) return;

  const items = rolloutItems(transcript);
  trace('items', items.length);
  if (items.length < 8) return;

  const asker = dry ? fakeAsker() : new JevClient({ apiKey });
  const result = await compactCodexItems(items, asker, {});

  const byId = new Map();
  for (const item of items) {
    if (typeof item.call_id !== 'string') continue;
    const slot = byId.get(item.call_id) ?? {};
    if (item.type === 'function_call' || item.type === 'custom_tool_call') slot.call = item;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') slot.output = item;
    byId.set(item.call_id, slot);
  }

  // Codex has already discarded this history, so there is nothing to protect by
  // leaving a result out — the only question is what to restore. Rank every
  // scored pair by how much Jev wants it (result verbatim first, then the call)
  // and inject the best until the budget fills, rather than gating on a fixed
  // keep threshold that a compressed transcript rarely clears.
  const MIN_SCORE = Number(process.env.FAST_JEV_MIN_SCORE ?? '0.2');
  const scored = result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map((d) => ({ d, score: Math.max(d.keepResult ?? 0, d.keepCall ?? 0) }))
    .filter((x) => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  trace('decisions', result.decisions.length, 'eligible', scored.length,
    'top', scored.slice(0, 3).map((x) => x.score.toFixed(2)).join(','));

  const sections = [];
  let used = 0;
  for (const { d, score } of scored) {
    const pair = byId.get(d.call_id);
    if (!pair?.call || typeof pair.output?.output !== 'string') continue;
    if (looksOpaque(pair.output.output)) continue;
    const rawArgs = typeof pair.call.arguments === 'string' ? pair.call.arguments
      : typeof pair.call.input === 'string' ? pair.call.input : '';
    const args = looksOpaque(rawArgs) ? '[opaque payload omitted]' : clip(rawArgs, MAX_ARGS_CHARS);
    const section = `### ${d.tool} [keep ${score.toFixed(2)}]\nargs: ${args}\noutput:\n${clip(pair.output.output, MAX_OUTPUT_CHARS)}`;
    if (used + section.length > MAX_CONTEXT_CHARS) break;
    sections.push(section);
    used += section.length;
  }
  if (sections.length === 0) return;

  const header = 'Verbatim tool results from before compaction, ranked by how relevant Jev judged them to the ongoing task. Codex\'s native summary may have dropped these — treat them as recovered context:';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `${header}\n\n${sections.join('\n\n')}`,
    },
  }));
}

main().catch((error) => {
  if (process.env.FAST_JEV_DEBUG === '1') console.error(error);
});
