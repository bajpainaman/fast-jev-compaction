import { compact, resolveOptions } from './compact.js';
import { collectToolCalls } from './state.js';
import type { CompactOptions, CompactResult, JevAsker, Message } from './types.js';

/** Codex ResponseItem objects retain fields that this adapter does not inspect. */
export interface CodexItem {
  type: string;
  [key: string]: unknown;
}

export type CodexCallDecision = CompactResult['decisions'][number] & { call_id: string };

export interface CodexCompactResult {
  items: CodexItem[];
  decisions: CodexCallDecision[];
  stats: CompactResult['stats'];
}

function messageText(item: CodexItem): string {
  if (!Array.isArray(item.content)) return `[${item.type}]`;
  return item.content.map((part: unknown) => {
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
      return part.text;
    }
    return '[non-text content preserved]';
  }).join('\n');
}

/**
 * Score a projection, then apply decisions to the original Codex items.
 * The caller supplies the scorer and installs the returned history in Codex.
 * This function does not write rollouts or replace a running session's history.
 */
export async function compactCodexItems(
  items: readonly CodexItem[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CodexCompactResult> {
  const calls = new Map<string, number[]>();
  const outputs = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (typeof item.call_id !== 'string') return;
    const map = item.type === 'function_call' || item.type === 'custom_tool_call'
      ? calls
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
        ? outputs : undefined;
    if (map) map.set(item.call_id, [...(map.get(item.call_id) ?? []), index]);
  });

  const eligible = new Set<string>();
  for (const [id, indices] of calls) {
    const resultIndices = outputs.get(id);
    if (indices.length !== 1 || resultIndices?.length !== 1) continue;
    const callIndex = indices[0]!;
    const resultIndex = resultIndices[0]!;
    const call = items[callIndex]!;
    const output = items[resultIndex]!;
    const expected = call.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output';
    if (resultIndex <= callIndex || output.type !== expected || typeof output.output !== 'string') continue;
    if (typeof call.name !== 'string' || call.encrypted_function_args != null) continue;
    if (call.type === 'function_call' && typeof call.arguments !== 'string') continue;
    if (call.type === 'custom_tool_call' && typeof call.input !== 'string') continue;
    eligible.add(id);
  }

  // Keep one projection entry per original item so recent-item pinning stays exact.
  const messages: Message[] = items.map((item) => {
    const id = typeof item.call_id === 'string' ? item.call_id : '';
    if (eligible.has(id) && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
      return {
        role: 'assistant', text: '',
        toolUses: [{ tool_use_id: id, tool: item.name as string,
          input: item.type === 'function_call'
            ? { arguments: item.arguments } : { input: item.input } }],
      };
    }
    if (eligible.has(id) && (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')) {
      return { role: 'user', text: '', toolUses: [],
        toolResults: [{ tool_use_id: id, text: item.output as string }] };
    }
    const role = item.role === 'user' ? 'user' : 'assistant';
    const text = item.type === 'message'
      ? `${item.role === 'system' || item.role === 'developer' ? `[${item.role}]\n` : ''}${messageText(item)}`
      : `[${item.type} preserved]`;
    return { role, text, toolUses: [] };
  });
  const resolved = resolveOptions(options);
  const paired = collectToolCalls(messages, resolved.preserveRecentMessages);
  const checkedAsker: JevAsker = {
    async ask(state, questions) {
      const response = await asker.ask(state, questions);
      for (const key of Object.keys(questions)) {
        const answer = response.answers[key];
        if (!answer || !('noul' in answer) || typeof answer.noul !== 'number'
          || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          throw new Error(`Invalid Codex keep probability for ${key}`);
        }
      }
      return response;
    },
  };
  const result = await compact(messages, checkedAsker, options);
  // Core decision ids are positional (`t1`, `t2`, …); map each back to the
  // Codex call_id so callers can address the original items.
  const decisions = result.decisions.map((decision, index) => ({
    ...decision, call_id: paired[index]!.tool_use_id,
  }));
  const actions = new Map(decisions.map((decision) => [decision.call_id, decision.action]));
  const texts = new Map(result.messages.flatMap((message) =>
    (message.toolResults ?? []).map((output) => [output.tool_use_id, output.text] as const)));
  const kept = items.flatMap((item): CodexItem[] => {
    if (typeof item.call_id !== 'string' || !eligible.has(item.call_id)) return [item];
    if (!['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      return [item];
    }
    const action = actions.get(item.call_id);
    if (action === 'drop_call') return [];
    if (action === 'drop_result' && (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')) {
      const text = texts.get(item.call_id)!;
      return [text === item.output ? item : { ...item, output: text }];
    }
    return [item];
  });
  return {
    items: kept, decisions,
    stats: { ...result.stats, messagesBefore: items.length, messagesAfter: kept.length,
      charsBefore: JSON.stringify(items).length, charsAfter: JSON.stringify(kept).length },
  };
}
