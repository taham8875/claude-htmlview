---
name: htmlview-artifact
description: Use when output would be substantially clearer as a standalone HTML page than as terminal markdown - comparisons of three or more options, specs, code reviews with per-item severity, anything needing a diagram, or an interactive parameter tuner. Writes a self-contained HTML artifact to the claude-htmlview library.
---

# Writing an HTML artifact

Write a self-contained HTML file under `$HTMLVIEW_ARTIFACTS_DIR` when that
environment variable is non-empty. Otherwise use:

`~/.local/share/claude-htmlview/artifacts/<encoded-project>/<YYYY-MM-DD-HHmm>-<slug>.html`

The viewer also reads the legacy `~/.claude/htmlview/artifacts` library. Write
new artifacts only to the path above unless the environment overrides it.

`<encoded-project>` is the current working directory with every `/` replaced
by `-`, matching the viewer's shared project convention
(`/home/you/code/myapp` -> `-home-you-code-myapp`).

Browse the library at `http://127.0.0.1:7317/artifacts`. A single artifact is
served directly at `http://127.0.0.1:7317/artifact/<encoded-project>/<file>.html`
(note: singular `/artifact/` for a file, plural `/artifacts` for the browsable
list).

## When this is warranted

Use an artifact when the content is genuinely spatial, comparative, or
interactive:

- A comparison of three or more options where tradeoffs need to sit side by side
- A spec or plan where structure carries meaning
- A code review where each finding needs its own severity and location
- Anything that wants a diagram — SVG beats an ASCII sketch
- An interactive tuner: sliders or inputs that let parameters be explored

## When it is NOT warranted

Do not reach for this by default. Terminal markdown is correct for:

- A short prose answer
- A single code block
- A linear list
- Anything under roughly a screen of output

The cost of a wrong call here is a file nobody opens, plus tokens spent
generating it. When in doubt, answer in the terminal.

## Requirements

- **Visual direction.** Use dark mode with a true black (`#000`) background and
  white primary text. Keep the layout information-dense, flat, and free of
  decorative card or pill chrome. Start sections with direct headings, without
  light-gray subtitle lines above them. Keep copy minimal and use no em dashes.
  Draw diagrams, graphs, or other visualizations when they materially improve
  understanding.
- **Self-contained.** No CDN scripts, no external stylesheets, no remote fonts
  or images, no network calls of any kind. The page must render fully offline.
- **Bidi-safe.** Set `dir="auto"` on every block element, force `dir="ltr"` on
  `<pre>`, and set `unicode-bidi: isolate` on inline `code`, `a`, and `strong`.
  Use `text-align: start`, never `left`. Content is frequently mixed
  Arabic/English and must remain readable in both directions.
- **Local fonts only.** Use generic system stacks (`system-ui`, `ui-monospace`)
  plus any Arabic face you have installed, e.g. `"Noto Sans Arabic UI"`. Never
  `@import` or link to a font CDN.
- **Export button on anything interactive.** Any editor or tuner ends with a
  "copy as JSON" or "copy as prompt" button, so adjustments can flow back into
  a prompt or into version control.
- **Announce the path.** After writing, print the artifact path and its
  `http://127.0.0.1:7317/artifact/...` URL so it can be opened directly.
