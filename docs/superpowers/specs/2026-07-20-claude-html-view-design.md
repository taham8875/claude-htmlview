# claude-htmlview — Design

**Date:** 2026-07-20
**Status:** Approved, pending implementation plan

## Motivation

Two problems, one solution.

**1. Mixed Arabic/English is unreadable in the terminal.** A terminal renders a grid of cells in *logical* order. Correct bidirectional text requires the Unicode Bidirectional Algorithm to reorder an entire paragraph for *display*, but terminals wrap lines first and render each independently, shattering the reordering at every wrap point. Most Linux terminals do not implement the UBA at all, and many lack the shaping engine Arabic requires for contextual letterforms. This is structural, not a misconfiguration. The browser is the only renderer on the machine with a correct UBA implementation plus HarfBuzz shaping.

**2. HTML artifacts get thrown away.** The [Anthropic blog post on HTML output](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) argues for maintaining a *web of HTML files* — specs, code reviews, reports, interactive editors — kept as durable references and re-fed into later sessions. That premise collapses if artifacts land in `/tmp` as one-click-then-forgotten files. They need an indexed, cross-linked home.

### Explicit non-goal: making Claude respond in HTML

The naive reading of the blog post is "have Claude emit HTML instead of markdown". Rejected, for two reasons:

- **It costs tokens on every turn.** HTML is roughly 3–5x markdown for equivalent content, on every response, forever.
- **It does not improve bidi at all.** `dir="auto"` behaves identically whether Claude authored the `<p>` or the renderer did. The fix belongs in the renderer.

Claude keeps writing markdown (cheap, fast, native). The *viewer* is HTML. Artifacts are HTML when the content genuinely warrants it.

## Architecture

Two processes. No hook. Nothing installed into Claude Code's path.

```
~/.claude/projects/**/*.jsonl   <- Claude Code writes (we only ever read)
            |
            | fs.watch
            v
   +-----------------+
   |  Bun server     |  parse JSONL -> normalized turns
   |  127.0.0.1:PORT |  index sessions by project + mtime
   +--------+--------+
            | SSE
            v
   +-----------------+
   |  Browser tab    |  marked.js -> HTML, dir="auto", collapsed tools
   +-----------------+

~/.claude/htmlview/artifacts/<project>/   <- Claude writes standalone HTML here
            |                                (indexed by the same server)
            +- cross-linked with the turn that produced it
```

### Why no `Stop` hook

An earlier draft used a `Stop` hook to push each turn. Dropped in favour of tailing transcripts directly, which is strictly better:

- Nothing to install in `settings.json`; nothing to break on a Claude Code update.
- No cursor coordination between hook and server.
- No transcript-lag race — `fs.watch` fires *on* the write rather than alongside it.
- **The entire back-catalogue works retroactively.** At time of writing: 146 sessions across 17 projects, 149MB. All browsable on day one.

### Read-only invariant

The server never writes to `~/.claude/projects`, never modifies `settings.json`, never wraps the CLI. If it crashes, Claude Code does not notice. This is the property that makes the tool safe to keep running.

### Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `transcript.ts` | JSONL -> normalized turn objects (dedupe by `message.id`, group text/tool/thinking blocks) | nothing |
| `index.ts` | scan projects dir; list sessions with title, project, mtime, turn count | `transcript.ts` |
| `server.ts` | routes, SSE, static assets | both above |
| `app.js` (client) | markdown -> HTML, bidi rules, collapse, scroll-follow | vendored `marked.js` |

`transcript.ts` holds the only non-trivial logic and is pure: JSONL in, objects out. Testable with no server and no browser.

### Definition of a "turn"

Used throughout with a precise meaning: **one user message plus every assistant message and tool exchange that follows it, up to the next user message.** A turn therefore contains an ordered list of blocks — assistant text, tool_use paired with its tool_result, and thinking — which may span several `message.id` values. This is the unit rendered in the thread view and the unit counted for pagination.

## Stack

**Bun server + client-side markdown via a vendored `marked.js`.**

Zero npm dependencies. The dependency surface is the most likely cause of rot in six months, and here it is a single vendored file that never needs updating. `Bun.serve` handles SSE in a few lines.

Markdown is stored raw, so server-side rendering can be added later (e.g. to export a standalone rendered turn) without a data migration.

## Rendering and bidi

Fonts already present on the machine — no downloads, no `@font-face`, no external requests:
`Noto Sans Arabic`, `Noto Sans Arabic UI`, `Noto Naskh Arabic` (full weight ranges), `Iosevka NFM`, `DejaVu Sans Mono`.

Six rules, applied client-side after `marked.js` parses. Rules 1–3 address essentially all of the observed pain.

1. **`dir="auto"` on every block element** — walk the parsed DOM, set on `p, li, td, th, h1`–`h6`, `blockquote`. Uses the first-strong-character heuristic, so direction resolves per block with no tagging from Claude.
2. **`<pre>` forced `dir="ltr"`** — code is LTR even inside Arabic prose. Without this, a code block in an RTL context flips and becomes unreadable.
3. **`unicode-bidi: isolate` on inline `<code>`, `<a>`, `<strong>`** — prevents an English identifier inside an Arabic sentence from dragging surrounding punctuation to the wrong end.
4. **Font stack, no explicit switching** — `Noto Sans Arabic UI` listed after the Latin sans; the browser falls back per glyph. Mono: `Iosevka NFM, DejaVu Sans Mono`.
5. **`text-align: start`, never `left`** — alignment follows `dir` without separate logic.
6. **Looser line-height on RTL blocks** — Arabic diacritics and taller ascenders collide at Latin leading.

## Routes

**`/` — Index.** Sessions grouped by project, with the directory name decoded (`-home-taha-github-docmost` -> `~/github/docmost`), sorted by mtime. Each row: derived title (first user message, truncated), turn count, last-active.

**`/s/:id` — Thread.** The reading surface.

- *User messages* — distinct, quiet styling; waypoints rather than content.
- *Assistant text* — full width, all six bidi rules applied.
- *Tool calls* — `<details>` collapsed. Summary line reads `Bash · check installed fonts` (tool name + description or first argument). Expand for full input and output.
- *Thinking blocks* — behind a toggle, off by default.
- *Artifacts* — HTML files produced during a turn appear as inline cards linking to the artifact.

**`/live` — redirects to the most recently modified session.** The route to keep pinned: always shows the current working session, with no session IDs to bookmark or hunt for.

**`/artifacts` — Artifact library.** Indexed from `~/.claude/htmlview/artifacts/`.

### Live updates

`fs.watch` -> SSE -> append. Scroll-follows **only when already scrolled to the bottom**, so reading history is never yanked.

### Scale handling

At 149MB of transcripts these are correctness requirements, not optimizations:

- **Tool outputs truncate at ~4KB** with a "show more" control. Some transcripts contain whole-file reads; rendering those raw would hang the tab.
- **Threads paginate from the end** — last 50 turns, "load earlier" upward. Reading the most recent turn must not cost a full parse of a multi-megabyte session.

## Artifact library

**Location:** `~/.claude/htmlview/artifacts/<project>/<timestamp>-<slug>.html`, self-contained standalone HTML.

Central rather than in-repo, so artifacts never pollute a git tree or leak into a commit.

**Cross-linking is bidirectional:** thread -> artifacts it produced, artifact -> thread it came from. This is what makes the blog's "web of HTML files" navigable rather than a folder of orphans.

**Trigger: a skill,** `htmlview:artifact`, carrying the criteria for when HTML output is warranted — a comparison of three or more options, a spec, a code review, anything with a diagram, any interactive tuner.

Chosen over the alternatives because it costs nothing until it triggers, and the criteria live in one editable file that can be tuned once real usage reveals what is actually wanted. A CLAUDE.md rule was explicitly rejected: a standing instruction to consider HTML output on every turn is permanent context cost and would quietly degrade ordinary short answers.

## Failure modes

**The one that will actually bite:** `fs.watch` fires *during* a write, so a JSONL file will routinely be read with a half-written final line.

> **Rule:** parse line-by-line; skip any line that fails `JSON.parse`; never treat it as fatal.

The next watch event picks up the complete line. Every transcript read is best-effort and idempotent — state is re-derived from the file rather than accumulated, so a dropped event is self-healing.

**Watch strategy:** recursive `fs.watch` support varies by platform and runtime, so it is not depended upon. Watch `~/.claude/projects` for new project directories, plus one watcher per project directory. Two levels, ~18 watchers, well under any inotify limit.

**Other cases:**

- Port in use -> bind the next free port and print it.
- Session file deleted mid-read -> drop from index, do not crash.
- Transcript with zero assistant turns -> render empty, not an error.
- **Unrecognized entry type -> render a neutral placeholder, never drop silently.** A Claude Code format change must be visible rather than invisible.

## Security

Bind `127.0.0.1` only, never `0.0.0.0`. Default port **7317**, overridable via `--port`; if taken, bind the next free port and print it.

Transcripts contain file contents, environment values, and potentially credentials. This server must not be reachable from the network. No auth layer, because localhost-only *is* the boundary.

## Testing

Built with the `tdd` skill. Parser first, since every other unit depends on its output shape.

- **Parser** — the real test surface, and pure. Fixture JSONL files hand-trimmed from real sessions -> asserted turn objects. Covers multi-block messages, `message.id` dedupe, tool_use/tool_result pairing, thinking blocks, and a truncated final line.
- **Bidi rules** — golden tests: mixed Arabic/English markdown in, assert `dir` attributes and isolation land on the correct nodes. Run against a real browser via the Playwright MCP, since the point is real UBA behaviour rather than a simulated DOM.
- **Server** — integration: point at a fixture projects directory, `fetch` each route, assert shape.
- **Not tested:** visual styling. Fonts and leading are judgment calls, iterated in the browser.

## Deferred

Not in v1. Listed so the decisions are not re-litigated.

- **Interactive input from the browser.** Permitted (see below) and technically viable, but the terminal handles input fine and it roughly doubles the build. If added later, the sanctioned route is the Channels feature rather than shelling out to the CLI.
- **Server-side markdown rendering.** Only needed to export a standalone rendered turn. Raw markdown is stored, so this is additive.
- **Full-text search across sessions.** Likely the highest-value v2 addition given 146 sessions; deliberately cut from v1 to keep scope on the two stated problems.

## Verified facts

Checked against official documentation on 2026-07-20, rather than assumed.

**Hooks cost nothing.** `command` / `http` / `mcp_tool` hooks are shell processes and invoke no model. Two exceptions: `type: "prompt"` and `type: "agent"` hooks *do* call a model, and hook stdout injected as context is billed as input tokens on the next turn. Moot for this design, which uses no hooks.

**Billing follows auth method, not interface.** Per the docs: *"If your organization mixes sign-in methods, each developer is metered according to the one they authenticated with."* A local UI shelling out to a `claude` CLI authenticated via claude.ai login draws on the **subscription**, not API credits. The Agent SDK uses an API key and therefore API credits — that is the actual distinction, not CLI-versus-other-interface.

**Third-party interfaces are not banned.** Consumer ToS §3(7) prohibits automated access *"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"* — and Anthropic ships `claude -p`, GitHub Actions, GitLab CI/CD, Channels, and `--output-format stream-json` (designed for third-party UIs). First-party non-CLI surfaces include web (claude.ai/code), desktop, VS Code, JetBrains, Slack, iOS/Android, and Chrome. What *is* prohibited: account sharing, reselling subscription capacity, and building a competing commercial product.

**Caveat on headless auth.** `claude -p` works with subscription auth today, but `claude -p --bare` requires `ANTHROPIC_API_KEY`, and the docs state `--bare` *"will become the default for `-p` in a future release."* Relevant only if browser-side input is built later.

**Stop hook payload** (recorded in case a hook is ever wanted): stdin includes `session_id`, `transcript_path`, `cwd`, and `last_assistant_message`. Docs advise preferring `last_assistant_message` over reading the transcript, since the transcript is written asynchronously.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Live view **and** artifact library |
| Live view role | Primary reader, built as a mirror first |
| Content | Full turns from transcript, tool calls collapsed |
| Stack | Bun + vendored `marked.js`, zero dependencies |
| Ingestion | No hook — server tails transcripts directly |
| Artifact trigger | A skill carrying the criteria |
| Arabic fix | Six bidi rules client-side; Noto fonts already installed |
| Location | `~/github/claude-htmlview` |
