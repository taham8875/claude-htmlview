# claude-htmlview

A local, read-only web viewer for [Claude Code](https://claude.com/claude-code)
and [Codex](https://developers.openai.com/codex/) session transcripts. It reads
their local history and renders both in one browser, with correct mixed
Arabic/English rendering, full-text search, and live updates while a session is
running.

It exists to solve two concrete problems:

1. **Mixed Arabic/English renders wrongly in terminals.** Terminal bidi handling
   breaks on mixed-direction text — RTL words next to LTR code, punctuation, and
   numbers. This server applies its own bidi rules so the same content reads
   correctly in a browser.
2. **HTML artifacts get thrown away.** Coding agents can produce HTML artifacts
   during a session, but there is nowhere for them to persist and be browsed
   later. This server hosts a cross-linked library of them.

Nothing leaves your machine: the server binds to `127.0.0.1` only, and never
writes to either transcript source.

## Requirements

- [Bun](https://bun.sh) 1.1 or newer. No Node, no build step.
- Claude Code or Codex, with at least one local session.

## Install and run

```bash
git clone https://github.com/taham8875/claude-htmlview.git
cd claude-htmlview
bun install          # dev types only; the server itself has no dependencies
bun run start        # http://127.0.0.1:7317
```

If the port is taken, the server walks up to the next 20 ports rather than
crashing. To pick one yourself:

```bash
bun run start -- --port 8080
```

Pin `http://127.0.0.1:7317/live` — it redirects to whichever session was most
recently active, so it is the one link worth bookmarking.

## Using it

- **`/`** — the index. Opens on the most recently active project, with the rest
  in a side rail. The selection lives in the URL (`/?project=<encoded-project>`,
  or `/?project=*` for every session on the machine), so a filtered index is
  bookmarkable and survives back/forward.
- **`/s/<session-id>`** — one transcript. Loads the last 50 turns with a "load
  earlier turns" control; tool calls are collapsed by default.
- **`/search?q=...`** — full-text search across human and assistant prose.
  Arabic-aware: tashkeel, tatweel, alef forms, and Arabic-Indic digits are all
  normalized, so `مشكله` matches `مُشْكِلَة`.
- **`/live`** — redirects to the most recently active session.
- **`/artifacts`** — the artifact library (see below).

While a session is running, the open page updates itself over SSE. If you have
scrolled up or paged back through history, the update is held behind a "new
activity" pill instead of yanking you to the bottom.

## Configuration

Reads `~/.claude/projects` and `~/.codex/sessions` **read-only**. All writes go under
`~/.claude/htmlview/`, split across two independently overridable directories —
useful for pointing either at a different location, or isolating them in tests:

| Variable | Purpose | Default |
|---|---|---|
| `HTMLVIEW_CLAUDE_PROJECTS_DIR` | Claude Code transcript source | `~/.claude/projects` |
| `HTMLVIEW_CODEX_SESSIONS_DIR` | Codex transcript source | `~/.codex/sessions` |
| `HTMLVIEW_CACHE_DIR` | Derived full-text search cache | `~/.claude/htmlview/cache` |
| `HTMLVIEW_ARTIFACTS_DIR` | Artifact library | `~/.claude/htmlview/artifacts` |

The search cache is derived data — deleting it only costs one re-index.

## Artifact library

Artifacts are self-contained HTML pages written to:

```
~/.claude/htmlview/artifacts/<encoded-project>/<YYYY-MM-DD-HHmm>-<slug>.html
```

`<encoded-project>` is the working directory with `/` replaced by `-`, matching
the viewer's shared project convention. Browse the full library at
`/artifacts`; a single artifact is served at
`/artifact/<encoded-project>/<file>.html`.

Install the bundled skill for either agent that should write artifacts:

```bash
mkdir -p ~/.claude/skills
cp -r skills/htmlview-artifact ~/.claude/skills/

mkdir -p ~/.agents/skills
cp -r skills/htmlview-artifact ~/.agents/skills/
```

Both copies write to the same library. Set `HTMLVIEW_ARTIFACTS_DIR` in the
agent environment if you use a custom artifact location.

## Security

This serves your transcripts, which routinely contain file contents, paths, and
whatever secrets happen to have passed through a session. Accordingly:

- The listener is bound to `127.0.0.1` and never `0.0.0.0`. There is no flag to
  change this.
- Static files and artifacts are contained twice: lexically, and again after
  `realpath()`, because `stat()` follows symlinks past a lexical check. A
  symlink planted inside the served directory cannot read a file outside it.
  Both paths have regression tests.
- Session ids are validated against a strict charset before they reach a glob
  pattern.

There is no authentication, because there is no remote access to authenticate.
Do not put this behind a reverse proxy.

## Development

```bash
bun test
bun run typecheck
```

The server has zero runtime dependencies. `bun install` pulls only `@types/bun`
for typechecking. `public/vendor/marked.min.js` is vendored (MIT) so the client
needs no CDN.

Design notes and the original spec live in `docs/`.

## Limitations

Deliberately out of scope, recorded so they are not re-litigated:

- **No browser-side input.** The client is read-only; you cannot reply to a
  session from the browser.
- **No server-side markdown rendering.** Markdown is rendered client-side via
  `marked`. A server-side pipeline would only be needed to export a standalone
  rendered turn.
- **Search covers prose only.** Tool inputs and outputs are not indexed.
- **No ranking.** Results come back in match order, not scored by relevance.
- **No subagent transcripts.** Only top-level Claude and Codex sessions are
  indexed.
- **No thread → artifact links.** The transcript carries no reliable signal
  connecting a turn to an artifact it produced.

**Thinking blocks are never rendered.** Claude Code persists only an opaque
signature in the observed transcripts, and Codex reasoning is encrypted.
Rendering either would produce no readable content.

## License

MIT — see [LICENSE](LICENSE).
