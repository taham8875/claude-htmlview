# Repository Guide

## Safety

- Treat `~/.claude/projects` and `~/.codex/sessions` as read-only transcript sources.
- Runtime writes belong only in the configured cache and artifact directories.
- Keep the server bound to `127.0.0.1`; transcripts can contain sensitive data.

## Provider Boundaries

- Keep Claude parsing in `src/transcript.ts` and Codex parsing in `src/codex-transcript.ts`.
- Normalize provider records into the shared `Parsed`, `Turn`, and `Block` types before they reach search or UI code.
- Preserve raw Claude public session IDs. Prefix Codex public IDs with `codex-` for routes and cache files.
- Exclude subagent transcripts unless a task explicitly changes that product boundary.

## Verification

- Use Bun for development commands.
- Run focused tests while iterating, then `bun test` and `bun run typecheck` before completion.
- Keep tests isolated from real cache and artifact directories through the existing environment seams.
