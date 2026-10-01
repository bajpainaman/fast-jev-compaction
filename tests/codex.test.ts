import { describe, expect, it } from 'vitest';
import { compactCodexItems, type CodexItem, type JevAsker } from '../src/index.js';

const options = { preserveRecentMessages: 0, truncateHeadChars: 10 };
const output = 'exact result\n'.repeat(100);
const pair = (id = 'a', custom = false): CodexItem[] => [
  custom ? { type: 'custom_tool_call', call_id: id, name: 'apply_patch', input: '*** patch ***', id: 'call-id' }
    : { type: 'function_call', call_id: id, name: 'exec_command', arguments: '{"cmd":"npm test"}', id: 'call-id' },
  { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: id, output, id: 'result-id' },
];
const user: CodexItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix tests. Preserve generated files.' }] };
function scorer(call: number, result: number): JevAsker {
  return { async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) =>
      [key, { noul: key.startsWith('call_') ? call : result }])) };
  } };
}
const never: JevAsker = { async ask() { throw new Error('unexpected scoring'); } };

describe('Codex history adapter', () => {
  it('drops paired calls and keeps protected objects verbatim and in order', async () => {
    const protectedItems: CodexItem[] = [
      user, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Never delete data.' }] },
      { type: 'reasoning', encrypted_content: 'opaque' },
      { type: 'compaction', encrypted_content: 'checkpoint' },
      { type: 'future_item', data: 'unknown' },
    ];
    const input = [...protectedItems, ...pair()];
    const before = JSON.stringify(input);
    const result = await compactCodexItems(input, scorer(0, 0), options);
    expect(result.items).toEqual(protectedItems);
    result.items.forEach((item, i) => expect(item).toBe(protectedItems[i]));
    expect(JSON.stringify(input)).toBe(before);
    expect(result.stats.callsDropped).toBe(1);
  });

  it.each([false, true])('truncates text output and preserves metadata (custom=%s)', async (custom) => {
    const input = [user, ...pair('a', custom)];
    const result = await compactCodexItems(input, scorer(1, 0), options);
    expect(result.items[1]).toBe(input[1]);
    expect(result.items[2]).toMatchObject({ id: 'result-id', call_id: 'a' });
    expect(result.items[2]!.output).toContain(output.slice(0, 10));
    expect((result.items[2]!.output as string).length).toBeLessThan(output.length);
    expect(input[2]!.output).toBe(output);
  });

  it('keeps retained items as the original objects', async () => {
    const input = [user, ...pair()];
    const result = await compactCodexItems(input, scorer(0, 1), options);
    result.items.forEach((item, i) => expect(item).toBe(input[i]));
  });

  it('pins the first item and pairs touching recent items', async () => {
    const first = pair();
    expect((await compactCodexItems(first, never, options)).items).toEqual(first);
    const recent = [user, ...pair()];
    expect((await compactCodexItems(recent, never, { preserveRecentMessages: 1 })).items).toEqual(recent);
  });

  it.each([
    [pair()[0]!], [pair()[1]!], [...pair(), pair()[0]!], [...pair(), pair()[1]!],
    [pair()[1]!, pair()[0]!],
    [pair()[0]!, { ...pair()[1]!, type: 'custom_tool_call_output' }],
    [pair()[0]!, { ...pair()[1]!, output: [{ type: 'input_image', image_url: 'image' }] }],
    [{ ...pair()[0]!, encrypted_function_args: 'secret' }, pair()[1]!],
  ])('preserves unsupported or ambiguous pairs %#', async (...entries) => {
    const input = [user, ...entries];
    const result = await compactCodexItems(input, never, options);
    result.items.forEach((item, i) => expect(item).toBe(input[i]));
  });

  it('propagates scorer errors without mutating history', async () => {
    const input = [user, ...pair()];
    const before = JSON.stringify(input);
    await expect(compactCodexItems(input, never, options)).rejects.toThrow('unexpected scoring');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('preserves unknown items that share a call id', async () => {
    const unknown = { type: 'future_item', call_id: 'a', metadata: 'keep' };
    const result = await compactCodexItems([user, ...pair(), unknown], scorer(0, 0), options);
    expect(result.items).toEqual([user, unknown]);
    expect(result.items[1]).toBe(unknown);
  });

  it('handles parallel calls with independent decisions', async () => {
    const a = pair('a');
    const b = pair('b');
    const asker: JevAsker = { async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((key) =>
        [key, { noul: key.endsWith('t1') ? 0 : 1 }])) };
    } };
    const result = await compactCodexItems([user, a[0]!, b[0]!, b[1]!, a[1]!], asker, options);
    expect(result.items).toEqual([user, b[0], b[1]]);
  });

  it.each([-1, 2, NaN, Infinity])('rejects invalid probabilities (%s)', async (value) => {
    await expect(compactCodexItems([user, ...pair()], scorer(value, 0), options))
      .rejects.toThrow('Invalid Codex keep probability');
  });
});
