# claude-htmlview

A local Bun web server that reads Claude Code session transcripts from
`~/.claude/projects` — **read-only** — and renders them in a browser.

It exists to solve two concrete problems:

1. **Mixed Arabic/English renders wrongly in terminals.** Terminal bidi
   handling breaks on mixed-direction text (RTL words next to LTR code,
   punctuation, numbers). This server applies its own bidi rules to render
   the same content correctly in a browser.
2. **HTML artifacts get thrown away.** Claude Code can produce HTML
   artifacts during a session, but there's nowhere for them to persist and
   be browsed later. This server hosts a cross-linked library of them.

## Run

```bash
bun run start                # http://127.0.0.1:7317
bun run start -- --port 8080 # pick a different port
```

Pin `http://127.0.0.1:7317/live` — it redirects to whichever session was
most recently active, so it's the one link worth bookmarking.

Reads `~/.claude/projects` **read-only**. All writes go under
`~/.claude/htmlview/` (derived search cache + artifact library), or wherever
`HTMLVIEW_CACHE_DIR` points if you set it — useful for pointing the cache at
a different location or isolating it in tests.

## Measured facts

Taken from a full verification pass on 2026-07-20, against the real
`~/.claude/projects` corpus on this machine. Numbers will differ on other
machines/corpora — these are not targets, just what was actually observed.

- **Tests:** `bun test` → 107 pass, 0 fail, 220 `expect()` calls, ~2.4s.
  Repeated 6 times total (1 + 5 extra runs); 0 failures across all 6 runs.
- **Zero dependencies:** `package.json` has no `dependencies` or
  `devDependencies`; no `node_modules` directory exists.
- **Sessions indexed:** `/api/sessions` returned **88** sessions from the
  real corpus.
- **Search cache:** `~/.claude/htmlview/cache` holds **93** entries (a few
  more than the current 88 live sessions — the cache doesn't prune entries
  for sessions that have since been removed).
- **Startup time:** ~62ms from process start to the server accepting
  connections (warm cache, no new sessions to index).
- **Binding:** confirmed via `ss -ltnp | grep 7317` → `127.0.0.1:7317` only,
  never `0.0.0.0` or `*`.
- **Route smoke test** against the real corpus:

  | Route | Status | Time |
  |---|---|---|
  | `GET /` | 200 | ~3ms |
  | `GET /api/sessions` | 200 | ~343ms |
  | `GET /live` | 302 | ~304ms |
  | `GET /api/search?q=docmost` | 200 | ~363ms (2 hits) |
  | `GET /api/artifacts` | 200 | <1ms |

## Design

See `docs/superpowers/specs/2026-07-20-claude-html-view-design.md`.

## Artifact library

The `htmlview-artifact` skill (`~/.claude/skills/htmlview-artifact`) writes
self-contained HTML artifacts to:

```
~/.claude/htmlview/artifacts/<encoded-project>/<YYYY-MM-DD-HHmm>-<slug>.html
```

`<encoded-project>` is the working directory with `/` replaced by `-`,
matching Claude Code's own project-directory convention. Browse the full
library at `/artifacts`; a single artifact is served at
`/artifact/<encoded-project>/<file>.html`.

## Thinking blocks

Thinking blocks are never rendered, because Claude Code does not persist
thinking content to the transcript. A direct scan of the real corpus
(`~/.claude/projects/*/*.jsonl`, top-level session files only, as of this
verification pass) found **3,966 thinking blocks, all empty** — each has
`"thinking": ""` and only a long opaque `signature` field. Rendering an
empty block would just be visual noise, so the client skips them.

## What it does not do

These were deliberately scoped out. Recorded here so they aren't
re-litigated by a future reader:

- **Browser-side input.** The client is read-only; you can't reply to a
  session from the browser. Permitted as a future extension, but out of
  scope for v1 — Channels would be the natural route in if it's ever added.
- **Server-side markdown rendering.** Prose is shown close to raw; there's
  no markdown-to-HTML pipeline on the server.
- **Search over tool inputs/outputs.** The search cache indexes human and
  assistant prose only. Tool calls and their results are not searchable.
- **Ranked search.** Results are returned in match order, not scored or
  ranked by relevance.
- **Subagent transcript viewing.** Only top-level session transcripts are
  indexed and rendered; subagent transcripts (`*/subagents/*.jsonl`) are not
  surfaced in the UI.
- **Thread → artifact inline cross-links.** Task 12 implements the artifact
  library listing (artifact → project), but there's no reverse link from a
  transcript turn back to an artifact it produced — the transcript carries
  no reliable signal to make that link. Recording it would require the
  skill to write a sidecar manifest; treated as a scoped follow-up, not a
  v1 blocker.
