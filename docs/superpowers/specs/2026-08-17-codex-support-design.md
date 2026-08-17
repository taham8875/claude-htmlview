# Codex Support Design

## Goal

Make `claude-htmlview` display local Codex sessions with the same reading,
search, artifact, and live-update experience it already provides for Claude
Code, while preserving existing Claude behavior and links.

## Scope

The viewer remains a local, read-only transcript reader. It will support:

- Claude Code transcripts under `~/.claude/projects/*/*.jsonl`.
- Codex transcripts under `~/.codex/sessions/**/*.jsonl`.
- One merged project/session index, one reader, one search index, and one
  artifact library.
- Installing the bundled artifact skill for either agent.

It will not launch or control agents, send prompts, track usage or cost, expose
remote access, add provider settings UI, or adopt t3code's broader agent-harness
scope.

## Architecture

Claude and Codex remain separate transcript adapters that normalize into the
existing `Parsed`, `Turn`, and `Block` types. The session layer aggregates both
sources and exposes provider-qualified public IDs. Existing Claude public IDs
remain unchanged; Codex IDs use a `codex-` prefix so routes and cache filenames
cannot collide.

The current Claude parser remains in `src/transcript.ts`. A new
`src/codex-transcript.ts` owns Codex's record format. `src/sessions.ts` owns
source discovery and aggregation, including the different directory layouts
and Codex metadata needed to recover the project cwd.

## Codex Transcript Rules

For each Codex rollout:

- Read the first `session_meta` record for session ID, cwd, and source.
- Exclude rollouts whose source identifies them as a subagent or fork.
- Start a turn for `response_item` messages whose role is `user`.
- Append assistant `output_text` from `response_item` messages whose role is
  `assistant`, including commentary and final-answer phases.
- Represent `input_image` as an image placeholder without retaining payloads.
- Pair `function_call`/`custom_tool_call` records with their corresponding
  output records by `call_id`.
- Ignore developer messages, encrypted reasoning, and duplicate `event_msg`
  mirrors.
- Track the newest record timestamp as session activity.
- Derive the title from the first human message.

Malformed lines and unknown records must not crash parsing. Unknown response
items that could contain visible agent output are represented as placeholders;
known metadata and lifecycle events are ignored.

## Session Discovery and Identity

Claude discovery keeps its existing non-recursive project glob. Codex discovery
walks the year/month/day tree recursively and reads each `.jsonl` file. A
provider field is added to session metadata.

Claude routes keep their current raw session ID. Codex routes expose
`codex-<uuid>`. Lookups dispatch by that prefix and verify the transcript's own
metadata ID instead of trusting a filename alone.

Projects from both providers share one rail entry when their normalized cwd is
the same. The session row carries a concise `Claude` or `Codex` source label;
no other layout or visual redesign is included.

## Live Updates and Search

A generic directory-tree watcher replaces the Claude-specific two-level
watcher. It watches existing directories and newly created descendants without
using platform-dependent recursive `fs.watch`. Each source supplies its file-to
public-ID mapping. Changes rebuild only that session's cache and broadcast its
public ID over the existing SSE endpoint.

Search continues to index only human and assistant prose. Cache filenames use
the public session ID, naturally separating Codex from Claude. Cache extraction
uses the already-normalized parsed turns, independent of provider.

## Artifacts and Configuration

The artifact library defaults to `~/.local/share/claude-htmlview/artifacts` so
Claude Code and Codex share a provider-neutral location. The viewer continues
to read `~/.claude/htmlview/artifacts` for migration-free compatibility.
`HTMLVIEW_ARTIFACTS_DIR` remains the explicit-location escape hatch.

Add `HTMLVIEW_CLAUDE_PROJECTS_DIR` and `HTMLVIEW_CODEX_SESSIONS_DIR` overrides
for source roots. Existing programmatic `projectsDir` test seams remain valid
for Claude-only tests.

## Repository Guidance

A concise root `AGENTS.md` records the read-only invariant, Bun commands,
provider boundaries, and focused verification commands. It does not repeat
discoverable package metadata or implementation details.

## Testing

Add sanitized Codex fixtures and focused tests for parsing, subagent exclusion,
recursive discovery, provider-qualified lookup, merged ordering, provider-safe
cache entries, and live update IDs. Keep the existing Claude suite unchanged
where possible. Final verification is `bun test` and `bun run typecheck`.
