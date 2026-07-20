# Test fixtures

Hand-built JSONL modelling shapes verified against all 144 real local
transcripts on 2026-07-20. See the spec's "Transcript format" section.

- `basic.jsonl` — happy path: title, two turns, thinking, tool call.
- `truncated.jsonl` — final line cut mid-write, as a live file appears.
  **Must not end with a trailing newline.**
- `edge.jsonl` — every shape that breaks a naive parser: ignored entry
  types, `isMeta`, harness-injected strings, image blocks, `message.id`
  duplicates, array-valued `tool_result.content`, unknown entry type.

Do not "tidy" these files. Each oddity is deliberate.
