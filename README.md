# claude-htmlview

A local browser reader for Claude Code sessions.

- Renders mixed Arabic/English correctly (terminals cannot — see the spec).
- Indexes and searches every past session.
- Hosts a cross-linked library of HTML artifacts.

## Run

```bash
bun run start        # http://127.0.0.1:7317
bun run start -- --port 8080
```

Reads `~/.claude/projects` **read-only**. Writes only under `~/.claude/htmlview/`.

## Design

See `docs/superpowers/specs/2026-07-20-claude-html-view-design.md`.
