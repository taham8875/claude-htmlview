# Codex Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex as a second read-only transcript provider without changing the viewer's scope or breaking Claude Code support.

**Architecture:** Parse Claude and Codex independently into the existing turn model, aggregate provider-qualified sessions in the session layer, then reuse the current reader, search, artifacts, and SSE UI. Keep Claude IDs stable and prefix Codex IDs with `codex-`.

**Tech Stack:** Bun, TypeScript, `node:fs`, browser JavaScript, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-17-codex-support-design.md`

## Global Constraints

- Transcript source directories are always read-only.
- Preserve existing Claude session IDs, routes, and artifact files.
- Keep artifacts shared under `~/.claude/htmlview/artifacts` by default.
- Do not add dependencies or agent-control features.
- Keep the existing UI structure; add only concise provider identification.

---

### Task 1: Codex Transcript Adapter

**Files:**
- Create: `src/fixtures/codex-basic.jsonl`
- Create: `src/fixtures/codex-edge.jsonl`
- Create: `src/codex-transcript.test.ts`
- Create: `src/codex-transcript.ts`
- Modify: `src/transcript.ts`

**Interfaces:**
- Consumes: shared `Parsed`, `Turn`, and `Block` types from `src/transcript.ts`.
- Produces: `parseCodexTranscript(jsonl: string): CodexParsed`, where `CodexParsed` extends normalized parsed output with `id`, `cwd`, and `isSubagent` metadata.

- [ ] **Step 1: Add sanitized fixtures and failing parser tests**

Cover user/assistant turns, commentary plus final output, function and custom
tools, image placeholders, ignored developer/reasoning/event mirrors, malformed
lines, activity timestamps, metadata cwd/id, and subagent detection.

- [ ] **Step 2: Run the parser test and verify RED**

Run: `bun test src/codex-transcript.test.ts`

Expected: FAIL because `src/codex-transcript.ts` does not exist.

- [ ] **Step 3: Implement the minimal line reducer**

Export:

```ts
export type CodexParsed = Parsed & {
  id: string | null;
  cwd: string | null;
  isSubagent: boolean;
};

export function parseCodexTranscript(jsonl: string): CodexParsed;
```

Parse only the record shapes listed in the spec and pair tool outputs by
`call_id`. Keep all filesystem work outside this module.

- [ ] **Step 4: Run parser tests and the existing Claude parser tests**

Run: `bun test src/codex-transcript.test.ts src/transcript.test.ts`

Expected: PASS.

### Task 2: Dual-Provider Session Discovery

**Files:**
- Modify: `src/sessions.test.ts`
- Modify: `src/sessions.ts`
- Modify: `src/server.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `parseTranscript` and `parseCodexTranscript`.
- Produces: `SessionProvider`, provider-bearing `SessionMeta`, aggregated `listSessions`, and provider-dispatching `findSession`/`newestSession`.

- [ ] **Step 1: Add failing discovery and lookup tests**

Construct temporary Claude and Codex trees. Assert recursive Codex discovery,
cwd-based project names, skipped subagents, stable Claude IDs,
`codex-<uuid>` IDs, merged activity ordering, and safe lookups.

- [ ] **Step 2: Run session tests and verify RED**

Run: `bun test src/sessions.test.ts`

Expected: FAIL because the session APIs do not accept a Codex source.

- [ ] **Step 3: Implement source aggregation**

Use a source configuration with Claude and Codex roots, retaining the existing
single `projectsDir` argument as a Claude-only compatibility seam for tests.
Validate public IDs before any glob or filesystem lookup.

- [ ] **Step 4: Route all server reads through the aggregate APIs**

Use environment overrides `HTMLVIEW_CLAUDE_PROJECTS_DIR` and
`HTMLVIEW_CODEX_SESSIONS_DIR`. Keep response shapes backward compatible except
for the additive `provider` field.

- [ ] **Step 5: Run focused tests**

Run: `bun test src/sessions.test.ts src/server.test.ts`

Expected: PASS.

### Task 3: Provider-Safe Search and Live Updates

**Files:**
- Modify: `src/searchcache.test.ts`
- Modify: `src/searchcache.ts`
- Modify: `src/search.test.ts`
- Modify: `src/search.ts`
- Modify: `src/watch.test.ts`
- Modify: `src/watch.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: provider-qualified `SessionMeta.id`, `findSession`, and `listSessions`.
- Produces: caches/search hits keyed by public session ID and a generic JSONL tree watcher.

- [ ] **Step 1: Add failing cache and search tests for Codex IDs**

Assert cache filenames and returned hits retain `codex-<uuid>` and do not
collide with a Claude ID.

- [ ] **Step 2: Run cache/search tests and verify RED**

Run: `bun test src/searchcache.test.ts src/search.test.ts`

Expected: FAIL because cache extraction always calls the Claude parser.

- [ ] **Step 3: Reuse normalized turns when building cache entries**

Build searchable lines from the session returned by `findSession`, or dispatch
the parser by `session.provider`; do not infer a provider from transcript
content.

- [ ] **Step 4: Add failing recursive watcher tests**

Assert changes under Claude's project directory and Codex's year/month/day
tree emit the expected public IDs, including a day directory created after the
watcher starts.

- [ ] **Step 5: Run watcher tests and verify RED**

Run: `bun test src/watch.test.ts`

Expected: FAIL because `watchProjects` watches only one descendant level.

- [ ] **Step 6: Implement bounded tree watching and wire both sources**

Watch each discovered directory and attach watchers to newly created
directories. Filter `.jsonl` changes through a source-specific public-ID
function. Closing the handle must close every watcher and pending timer.

- [ ] **Step 7: Run focused tests**

Run: `bun test src/searchcache.test.ts src/search.test.ts src/watch.test.ts src/server.test.ts`

Expected: PASS.

### Task 4: Minimal Provider UI and Agent Documentation

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css` only if existing metadata styles cannot carry the provider label
- Create: `AGENTS.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `skills/htmlview-artifact/SKILL.md`

**Interfaces:**
- Consumes: additive `SessionMeta.provider`.
- Produces: visible source identification and Codex installation guidance.

- [ ] **Step 1: Add provider text using existing session metadata styling**

Display `Claude` or `Codex` without changing navigation, layout, color system,
or adding decorative chrome.

- [ ] **Step 2: Add concise repo and installation guidance**

Document both transcript roots, both skill install targets, environment
overrides, shared artifact storage, and the read-only invariant. Add root
`AGENTS.md` with Bun verification commands and provider boundaries.

- [ ] **Step 3: Update project description without renaming the package**

Keep `claude-htmlview` as the compatibility name and describe it as a Claude
Code and Codex transcript viewer.

- [ ] **Step 4: Run static and integration verification**

Run: `bun run typecheck && bun test`

Expected: both commands exit 0.

### Task 5: Final Verification

**Files:**
- Review all modified files.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: verified dual-provider behavior.

- [ ] **Step 1: Run the full automated suite fresh**

Run: `bun test && bun run typecheck`

Expected: both commands exit 0 with no failures.

- [ ] **Step 2: Exercise the real read-only index**

Start the server against the default source roots, request `/api/sessions`, and
verify the response contains both providers when both have sessions. Request a
Codex session route and verify it returns turns. Do not modify either source
tree.

- [ ] **Step 3: Review scope and filesystem safety**

Inspect `git diff --check`, `git diff --stat`, and `git status --short`. Confirm
all writes remain limited to the configured cache/artifact directories and no
t3code-style agent-control features entered the diff.

