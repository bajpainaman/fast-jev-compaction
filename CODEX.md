# Codex support

The library exports `compactCodexItems`. It scores supported tool pairs and
returns Codex history items. The caller must install the returned history.
This adapter does not replace compaction in the installed Codex CLI.

## Use

```ts
import { compactCodexItems, type JevAsker } from 'fast-jev-compaction';

// Supply a scorer that implements the Jev/SystemOne question protocol.
// It can use CLEF; the adapter does not select a model or make HTTP requests.
declare const scorer: JevAsker;
declare const history: Parameters<typeof compactCodexItems>[0];

const result = await compactCodexItems(history, scorer, {
  preserveRecentMessages: 6,
  maxStateTokens: 12000,
  maxRequestTokens: 15000,
});
// Install result.items through the host's history replacement interface.
```

## Preserved content

The adapter pairs `function_call` and `custom_tool_call` items with their outputs
by `call_id`. Only pairs with plain text outputs can change.
The first item and pairs touching the recent item window stay unchanged.

Instructions, messages, reasoning, images, encrypted content, and unknown item
types stay unchanged. The adapter also preserves pairs with missing items, duplicate
IDs, mismatched types, and outputs before their calls.
Retained items keep their original objects and metadata.

Scoring uses a text projection of the history. Non-text content uses a
placeholder in that projection. Tool outputs use character count notes, as in the
existing scoring engine. An error from the scorer leaves the input unchanged
and propagates to the caller.

## Runtime integration

Codex 0.159.2 provides `PreCompact` and `PostCompact` hooks. These hooks cannot
return replacement history. A `SessionStart` hook with the `compact` matcher
can add context after native compaction.

A hook integration can restore selected excerpts after native compaction.
Replacing native compaction requires a Codex runtime change that installs
`result.items` through `Session::replace_compacted_history`.
It must also keep Codex's context, checkpoint, persistence, and token accounting.
Editing a rollout file does not replace the running session's history.

Sources: [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[Codex 0.159.2 compaction source](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/compact.rs).

## CLEF follow-up

CLEF supports the Jev/SystemOne request and response format.
Its model card documents a default input limit of 16,384 tokens.
The example above uses budgets below that limit, but token estimates are not accurate counts.
An integration must check the serving endpoint's actual limits.

Source: [CLEF model card](https://huggingface.co/Cloudflare/clef/blob/main/README.md).
