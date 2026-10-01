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
  trace('decisions', result.decisions.length,
    result.decisions.filter((d) => d.reason === 'kept').length, 'kept');

  const byId = new Map();
  for (const item of items) {
    if (typeof item.call_id !== 'string') continue;
    const slot = byId.get(item.call_id) ?? {};
    if (item.type === 'function_call' || item.type === 'custom_tool_call') slot.call = item;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') slot.output = item;
    byId.set(item.call_id, slot);
  }

  const sections = [];
  let used = 0;
  for (const decision of result.decisions) {
    if (decision.reason !== 'kept') continue;
    const pair = byId.get(decision.call_id);
    if (!pair?.call || typeof pair.output?.output !== 'string') continue;
    const args = typeof pair.call.arguments === 'string' ? pair.call.arguments
      : typeof pair.call.input === 'string' ? pair.call.input : '';
    const section = `### ${decision.tool} (${decision.id})\nargs: ${clip(args, MAX_ARGS_CHARS)}\noutput:\n${clip(pair.output.output, MAX_OUTPUT_CHARS)}`;
    if (used + section.length > MAX_CONTEXT_CHARS) break;
    sections.push(section);
    used += section.length;
  }
  if (sections.length === 0) return;

  const header = 'Verbatim tool results from before compaction that Jev scored as still needed for the ongoing task (the native summary above may have lost them):';
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
