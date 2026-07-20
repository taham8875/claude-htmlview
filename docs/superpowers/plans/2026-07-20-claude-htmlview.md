# claude-htmlview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local browser-based reader for Claude Code sessions that renders mixed Arabic/English correctly, indexes and searches every past session, and hosts a cross-linked library of HTML artifacts.

**Architecture:** A Bun server tails `~/.claude/projects/*/*.jsonl` read-only via `fs.watch`, parses transcripts into normalized turns, and serves them over HTTP with SSE for live updates. The browser renders markdown to HTML via a vendored `marked.js`, then applies six bidi rules to the parsed DOM. Search runs a linear scan over a derived plain-text cache with Arabic normalization applied symmetrically to corpus and query.

**Tech Stack:** Bun (server, test runner, TypeScript), vanilla JS + vendored `marked.js` (client), zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-claude-html-view-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero npm dependencies.** `package.json` must have no `dependencies` and no `devDependencies`. The only vendored third-party file is `public/vendor/marked.min.js`.
- **Read-only invariant.** Never write to, move, or delete anything under `~/.claude/projects`. Never modify `~/.claude/settings.json`. The only paths written are under `~/.claude/htmlview/`.
- **Bind `127.0.0.1` only, never `0.0.0.0`.** Default port `7317`, overridable via `--port`; if taken, bind the next free port and print it.
- **Session discovery globs `*/*.jsonl` only, never recursively.** Recursive globbing lists subagent transcripts (`<project>/<session>/subagents/agent-*.jsonl`) as sessions.
- **Never fail on a malformed JSONL line.** Parse line-by-line, skip lines that fail `JSON.parse`, continue.
- **Never inline base64 image data** into search cache, snippets, or HTML.
- **All rendered text blocks carry the six bidi rules.** This includes search snippets, not just thread view.
- **Language:** TypeScript for server code (`src/*.ts`), plain JS for client code (`public/*.js`). Bun runs TypeScript directly; there is no build step.
- **Tests:** `bun test`. Test files are `src/*.test.ts`.
- **Commit after every task.** Do not batch commits.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Name, scripts, `"type": "module"`. No dependencies. |
| `src/normalize.ts` | Arabic + Latin text normalization. Pure, no imports. |
| `src/transcript.ts` | JSONL text → normalized `Turn[]`. Pure, no I/O. |
| `src/sessions.ts` | Scan projects dir; list sessions with title, project, mtime. Does I/O. |
| `src/searchcache.ts` | Build and read the derived text cache. Does I/O. |
| `src/search.ts` | Query the cache, produce ranked-by-recency hits with snippets. |
| `src/watch.ts` | Two-level `fs.watch`, debounced change events. |
| `src/server.ts` | Routes, SSE, static file serving, CLI entry. |
| `public/index.html` | Shell for all routes; client-side router. |
| `public/app.js` | Fetch, render, collapse, scroll-follow, SSE. |
| `public/bidi.js` | The six bidi rules. Separated so it is testable alone. |
| `public/style.css` | All styling, including font stacks and RTL leading. |
| `public/vendor/marked.min.js` | Vendored markdown parser. |
| `src/fixtures/*.jsonl` | Hand-built transcript fixtures for tests. |

**Dependency order:** `normalize` → `transcript` → `sessions` → `searchcache` → `search` → `watch` → `server`. Client files depend only on the server's JSON shapes.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore` (already exists — verify), `README.md`
- Create: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a working `bun test` command for all later tasks

- [ ] **Step 1: Verify Bun is available**

Run: `bun --version`
Expected: a version string, e.g. `1.3.6`. If this fails, stop — the whole plan assumes Bun.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "claude-htmlview",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run src/server.ts",
    "test": "bun test"
  }
}
```

Note: no `dependencies` or `devDependencies` keys at all. This is a global constraint, not an oversight.

- [ ] **Step 3: Write a smoke test**

```ts
// src/smoke.test.ts
import { test, expect } from "bun:test";

test("bun test runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Run the test**

Run: `bun test`
Expected: PASS, `1 pass, 0 fail`.

- [ ] **Step 5: Write `README.md`**

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add package.json src/smoke.test.ts README.md
git commit -m "chore: scaffold project with zero dependencies"
```

---

## Task 2: Arabic and Latin text normalization

**Files:**
- Create: `src/normalize.ts`
- Test: `src/normalize.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `normalize(text: string): string` — used by `searchcache.ts` and `search.ts`

**Why this is first:** it is pure, has no dependencies, and search correctness for the project's motivating content depends entirely on it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/normalize.test.ts
import { test, expect } from "bun:test";
import { normalize } from "./normalize";

test("strips tashkeel diacritics", () => {
  expect(normalize("مُشْكِلَة")).toBe(normalize("مشكلة"));
});

test("unifies all alef forms to bare alef", () => {
  for (const alef of ["أ", "إ", "آ", "ٱ"]) {
    expect(normalize(alef)).toBe("ا");
  }
});

test("unifies taa marbuta to haa", () => {
  expect(normalize("مشكلة")).toBe("مشكله");
});

test("unifies alef maqsura to yaa", () => {
  expect(normalize("على")).toBe("علي");
});

test("strips tatweel", () => {
  expect(normalize("مـــشكله")).toBe("مشكله");
});

test("folds Arabic-Indic digits to ASCII", () => {
  expect(normalize("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  expect(normalize("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
});

test("lowercases Latin", () => {
  expect(normalize("HeLLo")).toBe("hello");
});

test("the motivating case: مشكله matches مُشْكِلَة", () => {
  expect(normalize("مُشْكِلَة")).toBe(normalize("مشكله"));
});

test("is idempotent", () => {
  const input = "مُشْكِلَة HeLLo ٠١٢ على";
  expect(normalize(normalize(input))).toBe(normalize(input));
});

test("preserves length-independent content of mixed text", () => {
  expect(normalize("Fix مشكلة in docmost")).toBe("fix مشكله in docmost");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/normalize.test.ts`
Expected: FAIL — `Cannot find module './normalize'`.

- [ ] **Step 3: Implement normalization**

```ts
// src/normalize.ts

/** Tashkeel (Arabic diacritics), U+064B–U+0652, plus superscript alef U+0670. */
const TASHKEEL = /[ً-ْٰ]/g;
/** Tatweel (kashida), a purely decorative elongation. */
const TATWEEL = /ـ/g;
/** Alef with hamza above/below, madda, and wasla — all fold to bare alef. */
const ALEF_FORMS = /[أإآٱ]/g;
/** Arabic-Indic digits U+0660–U+0669 and extended Arabic-Indic U+06F0–U+06F9. */
const ARABIC_INDIC = /[٠-٩]/g;
const EXT_ARABIC_INDIC = /[۰-۹]/g;

/**
 * Normalize text for search. Applied symmetrically to both the indexed corpus
 * and the query, so `مشكله` matches `مُشْكِلَة`.
 *
 * Must be idempotent: normalize(normalize(x)) === normalize(x).
 */
export function normalize(text: string): string {
  return text
    .replace(TASHKEEL, "")
    .replace(TATWEEL, "")
    .replace(ALEF_FORMS, "ا")      // -> ا
    .replace(/ة/g, "ه")        // ة -> ه
    .replace(/ى/g, "ي")        // ى -> ي
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/normalize.test.ts`
Expected: PASS, `10 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/normalize.ts src/normalize.test.ts
git commit -m "feat: Arabic and Latin text normalization for search"
```

---

## Task 3: Transcript fixtures

**Files:**
- Create: `src/fixtures/basic.jsonl`, `src/fixtures/truncated.jsonl`, `src/fixtures/edge.jsonl`
- Create: `src/fixtures/README.md`

**Interfaces:**
- Consumes: nothing
- Produces: fixture files read by `transcript.test.ts` (Task 4) and `search.test.ts` (Task 7)

**Why separate:** these are data, reviewed for *fidelity to the real format*, which is a different review question from parser logic. Every shape here was verified against real transcripts (see spec, "Transcript format").

- [ ] **Step 1: Write `src/fixtures/basic.jsonl`**

One user message, one assistant turn with thinking + text + a tool call, then a second user message. Each line is a complete JSON object.

```jsonl
{"type":"ai-title","aiTitle":"Check the font setup","sessionId":"fixture-basic"}
{"type":"user","uuid":"u1","timestamp":"2026-07-20T10:00:00.000Z","isSidechain":false,"message":{"role":"user","content":"ما هي الخطوط المثبتة؟ check installed fonts"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-07-20T10:00:01.000Z","isSidechain":false,"message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"They want the font list.","signature":"sig"},{"type":"text","text":"سأتحقق من الخطوط. Let me check."},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"fc-list","description":"list fonts"}}]}}
{"type":"user","uuid":"u2","timestamp":"2026-07-20T10:00:02.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Noto Sans Arabic\nIosevka NFM"}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-07-20T10:00:03.000Z","isSidechain":false,"message":{"id":"msg_2","role":"assistant","content":[{"type":"text","text":"Noto Sans Arabic مثبت بالفعل."}]}}
{"type":"user","uuid":"u3","timestamp":"2026-07-20T10:01:00.000Z","isSidechain":false,"message":{"role":"user","content":"شكرا thanks"}}
{"type":"assistant","uuid":"a3","timestamp":"2026-07-20T10:01:01.000Z","isSidechain":false,"message":{"id":"msg_3","role":"assistant","content":[{"type":"text","text":"عفوا."}]}}
```

- [ ] **Step 2: Write `src/fixtures/truncated.jsonl`**

Models the live-file case: the final line is cut mid-write. **The file must not end with a newline after the partial line.**

```jsonl
{"type":"user","uuid":"u1","timestamp":"2026-07-20T10:00:00.000Z","isSidechain":false,"message":{"role":"user","content":"hello"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-07-20T10:00:01.000Z","isSidechain":false,"message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-07-20T10:00:02.000Z","isSidechain":false,"message":{"id":"msg_2","role":"assis
```

- [ ] **Step 3: Write `src/fixtures/edge.jsonl`**

Every shape that broke a naive parser, verified present in real data.

```jsonl
{"type":"mode","mode":"default"}
{"type":"last-prompt","promptId":"p1"}
{"type":"user","uuid":"m1","timestamp":"2026-07-20T09:00:00.000Z","isMeta":true,"isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Image: source: /home/taha/.claude/image-cache/x/1.png]"}]}}
{"type":"user","uuid":"n1","timestamp":"2026-07-20T09:00:01.000Z","isSidechain":false,"message":{"role":"user","content":"<task-notification>\n<task-id>abc</task-id>\n</task-notification>"}}
{"type":"user","uuid":"n2","timestamp":"2026-07-20T09:00:02.000Z","isSidechain":false,"message":{"role":"user","content":"<system-reminder>background context</system-reminder>"}}
{"type":"user","uuid":"u1","timestamp":"2026-07-20T09:00:03.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"real question"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUg=="}}]}}
{"type":"assistant","uuid":"a1","timestamp":"2026-07-20T09:00:04.000Z","isSidechain":false,"message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"considering","signature":"sig"},{"type":"text","text":"part one"}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-07-20T09:00:05.000Z","isSidechain":false,"message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"part two"}]}}
{"type":"assistant","uuid":"a3","timestamp":"2026-07-20T09:00:06.000Z","isSidechain":false,"message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Read","input":{"file_path":"/tmp/x.txt"}}]}}
{"type":"user","uuid":"u9","timestamp":"2026-07-20T09:00:07.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":[{"type":"text","text":"file body"}]}]}}
{"type":"some-future-entry-type","uuid":"f1","timestamp":"2026-07-20T09:00:08.000Z","payload":{"whatever":true}}
```

This covers, in order: ignored entry types; `isMeta` injection; `<task-notification>` string; `<system-reminder>` string; a real user message with an image block; **two assistant entries sharing `msg_1` carrying *different* blocks** (the streamed-message case — both must be kept, never deduped); a `tool_use` whose `tool_result.content` is an **array**; and an unknown entry type.

- [ ] **Step 4: Write `src/fixtures/README.md`**

```markdown
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
```

- [ ] **Step 5: Verify the fixtures are shaped as intended**

Run:
```bash
bun -e 'const t=await Bun.file("src/fixtures/truncated.jsonl").text();
const lines=t.split("\n");
let bad=0; for(const l of lines){ if(!l.trim())continue; try{JSON.parse(l)}catch{bad++} }
console.log("truncated.jsonl unparseable lines:", bad);
console.log("ends with newline:", t.endsWith("\n"));'
```
Expected: `unparseable lines: 1` and `ends with newline: false`. If either differs, the fixture does not model the live-file case and Task 4's truncation test would pass vacuously.

- [ ] **Step 6: Commit**

```bash
git add src/fixtures
git commit -m "test: transcript fixtures modelling verified real-world shapes"
```

---

## Task 4: Transcript parser

**Files:**
- Create: `src/transcript.ts`
- Test: `src/transcript.test.ts`

**Interfaces:**
- Consumes: `src/fixtures/*.jsonl` (Task 3)
- Produces:
  ```ts
  export type Block =
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool"; name: string; summary: string; input: unknown; result: string | null }
    | { kind: "image" }
    | { kind: "unknown"; entryType: string };

  export type Turn = { index: number; userText: string | null; blocks: Block[]; timestamp: string | null };
  export type Parsed = { title: string | null; turns: Turn[] };

  export function parseTranscript(jsonl: string): Parsed;
  ```
  Used by `sessions.ts` (Task 5), `searchcache.ts` (Task 6), `server.ts` (Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
// src/transcript.test.ts
import { test, expect } from "bun:test";
import { parseTranscript } from "./transcript";

const load = async (name: string) =>
  parseTranscript(await Bun.file(`src/fixtures/${name}.jsonl`).text());

test("extracts the ai-title", async () => {
  const p = await load("basic");
  expect(p.title).toBe("Check the font setup");
});

test("groups into turns bounded by user messages", async () => {
  const p = await load("basic");
  expect(p.turns.length).toBe(2);
  expect(p.turns[0].userText).toContain("check installed fonts");
  expect(p.turns[1].userText).toContain("thanks");
});

test("a turn spans multiple assistant message ids", async () => {
  const p = await load("basic");
  const texts = p.turns[0].blocks.filter((b) => b.kind === "text");
  expect(texts.length).toBe(2);
});

test("pairs tool_use with its tool_result", async () => {
  const p = await load("basic");
  const tool = p.turns[0].blocks.find((b) => b.kind === "tool") as any;
  expect(tool.name).toBe("Bash");
  expect(tool.result).toContain("Noto Sans Arabic");
});

test("tool summary prefers the description field", async () => {
  const p = await load("basic");
  const tool = p.turns[0].blocks.find((b) => b.kind === "tool") as any;
  expect(tool.summary).toBe("list fonts");
});

test("captures thinking blocks", async () => {
  const p = await load("basic");
  expect(p.turns[0].blocks.some((b) => b.kind === "thinking")).toBe(true);
});

test("skips the truncated final line without throwing", async () => {
  const p = await load("truncated");
  expect(p.turns.length).toBe(1);
  const texts = p.turns[0].blocks.filter((b) => b.kind === "text");
  expect(texts.length).toBe(1);
});

test("ignores isMeta user entries", async () => {
  const p = await load("edge");
  for (const t of p.turns) expect(t.userText ?? "").not.toContain("image-cache");
});

test("ignores harness-injected string content", async () => {
  const p = await load("edge");
  const all = p.turns.map((t) => t.userText ?? "").join(" ");
  expect(all).not.toContain("task-notification");
  expect(all).not.toContain("system-reminder");
  expect(all).toContain("real question");
});

test("concatenates blocks across entries sharing a message id", async () => {
  // Verified against the real corpus: one streamed message is split across
  // several JSONL lines under one message.id, each carrying the NEXT block.
  // 6388 such repeats carry differing content; zero carry identical content.
  // Deduping here discarded ~83% of all assistant blocks.
  const p = await load("edge");
  const kinds = p.turns[0].blocks.map((b) => b.kind);
  expect(kinds).toContain("thinking");
  expect(kinds).toContain("text");
  const texts = p.turns[0].blocks.filter((b) => b.kind === "text") as any[];
  expect(texts.map((t) => t.text)).toEqual(["part one", "part two"]);
});

test("handles array-valued tool_result content", async () => {
  const p = await load("edge");
  const tool = p.turns[0].blocks.find(
    (b) => b.kind === "tool" && (b as any).name === "Read"
  ) as any;
  expect(tool.result).toContain("file body");
});

test("represents a user-submitted image as a placeholder block", async () => {
  // 88 real user image blocks across 20 sessions — a pasted screenshot must be
  // visible as *something*, not silently dropped.
  const p = await load("edge");
  const turn = p.turns.find((t) => t.userText?.includes("real question"));
  expect(turn).toBeDefined();
  expect(turn!.blocks.some((b) => b.kind === "image")).toBe(true);
});

test("never carries base64 payload into parser output", async () => {
  const p = await load("edge");
  expect(JSON.stringify(p)).not.toContain("iVBORw0KGgo");
});

test("surfaces unknown entry types as placeholders", async () => {
  const p = await load("edge");
  const unknown = p.turns
    .flatMap((t) => t.blocks)
    .find((b) => b.kind === "unknown") as any;
  expect(unknown.entryType).toBe("some-future-entry-type");
});

test("returns empty rather than throwing on empty input", () => {
  expect(parseTranscript("")).toEqual({ title: null, turns: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/transcript.test.ts`
Expected: FAIL — `Cannot find module './transcript'`.

- [ ] **Step 3: Implement the parser**

```ts
// src/transcript.ts

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string; input: unknown; result: string | null }
  | { kind: "image" }
  | { kind: "unknown"; entryType: string };

export type Turn = {
  index: number;
  userText: string | null;
  blocks: Block[];
  timestamp: string | null;
};

export type Parsed = { title: string | null; turns: Turn[] };

/** Entry types we consume. Anything else is either ignored or flagged unknown. */
const CONSUMED = new Set(["user", "assistant", "ai-title"]);
/** Entry types known to exist and deliberately ignored (verified against real data). */
const IGNORED = new Set([
  "last-prompt", "mode", "permission-mode", "system", "file-history-snapshot",
  "attachment", "agent-name", "queue-operation", "file-history-delta", "frame-link",
]);
/** Harness-injected wrappers: present in string content, never typed by the human. */
const INJECTED = ["<task-notification>", "<system-reminder>", "<local-command-stdout>"];

/** Flatten tool_result content, which is a string on ~84% of entries and an array otherwise. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A one-line label for a collapsed tool call: description if present, else first string arg. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (typeof o.description === "string") return o.description;
  for (const v of Object.values(o)) {
    if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + "…" : v;
  }
  return "";
}

/** True if this user entry is a real human message rather than a harness injection. */
function isHumanMessage(entry: any): boolean {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") {
    return !INJECTED.some((marker) => content.includes(marker));
  }
  if (!Array.isArray(content)) return false;
  // A block array is a human message only if it has no tool_result blocks.
  return !content.some((b: any) => b?.type === "tool_result");
}

/** Human-visible text of a user message, excluding image payloads. */
function userText(entry: any): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("\n");
}

export function parseTranscript(jsonl: string): Parsed {
  let title: string | null = null;
  const turns: Turn[] = [];
  const pendingTools = new Map<string, { kind: "tool" } & Record<string, any>>();

  let current: Turn | null = null;
  const startTurn = (text: string | null, ts: string | null): Turn => {
    current = { index: turns.length, userText: text, blocks: [], timestamp: ts };
    turns.push(current);
    return current;
  };
  /** Blocks arriving before any user message still need a home. */
  const ensureTurn = (ts: string | null) => {
    if (!current) startTurn(null, ts);
    return current!;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // half-written final line of a live file — expected, never fatal
    }

    const type = entry?.type;

    if (type === "ai-title") {
      if (typeof entry.aiTitle === "string") title = entry.aiTitle;
      continue;
    }

    if (!CONSUMED.has(type)) {
      if (!IGNORED.has(type)) {
        ensureTurn(entry?.timestamp ?? null).blocks.push({
          kind: "unknown",
          entryType: String(type),
        });
      }
      continue;
    }

    if (entry.isSidechain) continue; // subagent content; out of scope for v1

    if (type === "user") {
      const content = entry.message?.content;
      // Tool results attach to the tool_use already recorded in this turn.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const tool = pendingTools.get(b.tool_use_id);
          if (tool) tool.result = flattenContent(b.content);
        }
      }
      if (isHumanMessage(entry)) {
        const turn = startTurn(userText(entry), entry.timestamp ?? null);
        // A pasted screenshot must be visible as *something*. 88 real user
        // image blocks across 20 sessions; base64 never carried forward.
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "image") turn.blocks.push({ kind: "image" });
          }
        }
      }
      continue;
    }

    // type === "assistant"
    //
    // Do NOT dedupe by message.id. One streamed message is written across
    // several lines under a single id, each carrying the next content block.
    // Verified: 6388 id-repeats carry differing content, zero carry identical
    // content. Keep-first dedupe discarded ~83% of all assistant blocks.
    const msg = entry.message;
    const turn = ensureTurn(entry.timestamp ?? null);
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    for (const b of blocks) {
      switch (b?.type) {
        case "text":
          if (b.text) turn.blocks.push({ kind: "text", text: b.text });
          break;
        case "thinking":
          if (b.thinking) turn.blocks.push({ kind: "thinking", text: b.thinking });
          break;
        case "tool_use": {
          const tool = {
            kind: "tool" as const,
            name: String(b.name ?? "unknown"),
            summary: toolSummary(b.input),
            input: b.input,
            result: null as string | null,
          };
          turn.blocks.push(tool);
          if (typeof b.id === "string") pendingTools.set(b.id, tool);
          break;
        }
        case "image":
          turn.blocks.push({ kind: "image" }); // never carry base64 forward
          break;
      }
    }
  }

  return { title, turns };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/transcript.test.ts`
Expected: PASS, `14 pass, 0 fail`.

- [ ] **Step 5: Verify against real transcripts**

The fixtures are hand-built; this checks the parser against the actual corpus. Run:

```bash
bun -e '
import { parseTranscript } from "./src/transcript";
import { Glob } from "bun";
let files=0, turns=0, unknown=0, titled=0, empty=0;
for await (const f of new Glob("*/*.jsonl").scan({ cwd: `${process.env.HOME}/.claude/projects`, absolute: true })) {
  files++;
  const p = parseTranscript(await Bun.file(f).text());
  turns += p.turns.length;
  if (p.title) titled++;
  if (p.turns.length === 0) empty++;
  unknown += p.turns.flatMap(t => t.blocks).filter(b => b.kind === "unknown").length;
}
console.log({ files, turns, titled, empty, unknown });
'
```

Expected: `files: 84`, `turns` in the low thousands, `titled: 82`, `empty` small (0–2), and **`unknown: 0`**. A non-zero `unknown` means a real entry type is missing from the `IGNORED` set — add it and re-run. A `files` value above 84 means the glob went recursive and is picking up subagent transcripts; fix the glob.

- [ ] **Step 6: Commit**

```bash
git add src/transcript.ts src/transcript.test.ts
git commit -m "feat: transcript parser producing normalized turns"
```

---

## Task 5: Session index

**Files:**
- Create: `src/sessions.ts`
- Test: `src/sessions.test.ts`

**Interfaces:**
- Consumes: `parseTranscript` from `src/transcript.ts` (Task 4)
- Produces:
  ```ts
  export type SessionMeta = {
    id: string; project: string; projectPath: string;
    title: string; turnCount: number; mtimeMs: number; file: string;
  };
  export function decodeProject(dirName: string): string;
  export function listSessions(projectsDir?: string): Promise<SessionMeta[]>;
  export function newestSession(projectsDir?: string): Promise<SessionMeta | null>;
  ```
  Used by `searchcache.ts` (Task 6) and `server.ts` (Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
// src/sessions.test.ts
import { test, expect } from "bun:test";
import { decodeProject, listSessions } from "./sessions";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("decodes an encoded project dir to a tilde path", () => {
  expect(decodeProject("-home-taha-github-docmost")).toBe("~/github/docmost");
  expect(decodeProject("-home-taha")).toBe("~");
});

async function fixtureDir() {
  const root = await mkdtemp(join(tmpdir(), "htmlview-"));
  const proj = join(root, "-home-taha-github-demo");
  await mkdir(proj, { recursive: true });
  const body = await Bun.file("src/fixtures/basic.jsonl").text();
  await writeFile(join(proj, "sess-a.jsonl"), body);
  // A subagent transcript, which must NOT be listed as a session.
  const sub = join(proj, "sess-a", "subagents");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "agent-x.jsonl"), body);
  return root;
}

test("lists sessions with decoded project and derived title", async () => {
  const s = await listSessions(await fixtureDir());
  expect(s.length).toBe(1);
  expect(s[0].id).toBe("sess-a");
  expect(s[0].project).toBe("~/github/demo");
  expect(s[0].title).toBe("Check the font setup");
  expect(s[0].turnCount).toBe(2);
});

test("never lists subagent transcripts as sessions", async () => {
  const s = await listSessions(await fixtureDir());
  expect(s.some((x) => x.id.startsWith("agent-"))).toBe(false);
});

test("returns empty for a missing projects dir rather than throwing", async () => {
  expect(await listSessions("/nonexistent/path/xyz")).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/sessions.test.ts`
Expected: FAIL — `Cannot find module './sessions'`.

- [ ] **Step 3: Implement the session index**

```ts
// src/sessions.ts
import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseTranscript } from "./transcript";

export type SessionMeta = {
  id: string;
  project: string;
  projectPath: string;
  title: string;
  turnCount: number;
  mtimeMs: number;
  file: string;
};

export const defaultProjectsDir = () => join(homedir(), ".claude", "projects");

/**
 * Claude Code encodes a cwd as a dir name by replacing "/" with "-".
 * "-home-taha-github-docmost" -> "~/github/docmost"
 */
export function decodeProject(dirName: string): string {
  const abs = dirName.replace(/-/g, "/");
  const home = homedir();
  if (abs === home) return "~";
  if (abs.startsWith(home + "/")) return "~" + abs.slice(home.length);
  return abs;
}

export async function listSessions(
  projectsDir: string = defaultProjectsDir()
): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  // NON-recursive by design: "*/*.jsonl" excludes <session>/subagents/agent-*.jsonl
  const glob = new Glob("*/*.jsonl");
  let files: string[] = [];
  try {
    for await (const f of glob.scan({ cwd: projectsDir, absolute: true })) files.push(f);
  } catch {
    return []; // missing or unreadable projects dir
  }

  for (const file of files) {
    try {
      const [st, text] = await Promise.all([stat(file), Bun.file(file).text()]);
      const parsed = parseTranscript(text);
      const id = basename(file, ".jsonl");
      const dirName = basename(dirname(file));
      out.push({
        id,
        project: decodeProject(dirName),
        projectPath: dirName,
        title: parsed.title ?? parsed.turns[0]?.userText?.slice(0, 80) ?? id,
        turnCount: parsed.turns.length,
        mtimeMs: st.mtimeMs,
        file,
      });
    } catch {
      continue; // deleted mid-scan, or unreadable — drop from index, never crash
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function newestSession(
  projectsDir: string = defaultProjectsDir()
): Promise<SessionMeta | null> {
  return (await listSessions(projectsDir))[0] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/sessions.test.ts`
Expected: PASS, `4 pass, 0 fail`.

- [ ] **Step 5: Verify against the real projects dir**

Run:
```bash
bun -e '
import { listSessions } from "./src/sessions";
const s = await listSessions();
console.log("sessions:", s.length);
console.log("subagents leaked:", s.filter(x => x.id.startsWith("agent-")).length);
console.log(s.slice(0, 3).map(x => `${x.project} — ${x.title} (${x.turnCount} turns)`));
'
```
Expected: `sessions: 84`, `subagents leaked: 0`, and three plausible titles. If sessions is 144, the glob went recursive.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts src/sessions.test.ts
git commit -m "feat: session index with project decoding, excluding subagents"
```

---

## Task 6: Derived search cache

**Files:**
- Create: `src/searchcache.ts`
- Test: `src/searchcache.test.ts`

**Interfaces:**
- Consumes: `parseTranscript` (Task 4), `listSessions`/`SessionMeta` (Task 5), `normalize` (Task 2)
- Produces:
  ```ts
  export type CacheLine = { turn: number; role: "user" | "assistant"; original: string; normalized: string };
  export function cacheDir(): string;
  export function buildCacheEntry(session: SessionMeta): Promise<void>;
  export function readCacheEntry(sessionId: string): Promise<CacheLine[]>;
  export function refreshCache(projectsDir?: string): Promise<number>;
  ```
  Used by `search.ts` (Task 7) and `watch.ts` (Task 8).

**Cache format:** one line per text block, tab-separated: `<turn-index>\t<role>\t<original text>`. Newlines and tabs inside text are escaped as `\n` and `\t`. The normalized form is computed on read rather than stored, keeping the file human-inspectable and halving its size.

- [ ] **Step 1: Write the failing tests**

```ts
// src/searchcache.test.ts
import { test, expect } from "bun:test";
import { buildCacheEntry, readCacheEntry, cacheDir } from "./searchcache";
import type { SessionMeta } from "./sessions";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

const meta = (id: string): SessionMeta => ({
  id, project: "~/demo", projectPath: "-home-taha-demo",
  title: "t", turnCount: 2, mtimeMs: Date.now(),
  file: "src/fixtures/basic.jsonl",
});

test("writes a cache entry and reads it back", async () => {
  await buildCacheEntry(meta("t-basic"));
  const lines = await readCacheEntry("t-basic");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.role === "user")).toBe(true);
  expect(lines.some((l) => l.role === "assistant")).toBe(true);
});

test("stores original text and exposes a normalized form", async () => {
  await buildCacheEntry(meta("t-norm"));
  const lines = await readCacheEntry("t-norm");
  const hit = lines.find((l) => l.original.includes("مثبت"));
  expect(hit).toBeDefined();
  expect(hit!.normalized).not.toContain("ً"); // no tashkeel survives
});

test("excludes tool inputs and outputs", async () => {
  await buildCacheEntry(meta("t-tools"));
  const joined = (await readCacheEntry("t-tools")).map((l) => l.original).join(" ");
  expect(joined).not.toContain("fc-list");
  expect(joined).not.toContain("Iosevka NFM");
});

test("excludes thinking blocks", async () => {
  await buildCacheEntry(meta("t-think"));
  const joined = (await readCacheEntry("t-think")).map((l) => l.original).join(" ");
  expect(joined).not.toContain("They want the font list");
});

test("round-trips text containing tabs and newlines", async () => {
  await buildCacheEntry({ ...meta("t-esc"), file: "src/fixtures/edge.jsonl" });
  const lines = await readCacheEntry("t-esc");
  for (const l of lines) expect(l.original).not.toContain("\\n\\t");
});

test("returns empty for an absent cache entry rather than throwing", async () => {
  await rm(join(cacheDir(), "t-missing.txt"), { force: true });
  expect(await readCacheEntry("t-missing")).toEqual([]);
});

test("cache is derived state: deleting the dir is harmless", async () => {
  await buildCacheEntry(meta("t-rebuild"));
  await rm(cacheDir(), { recursive: true, force: true });
  expect(await readCacheEntry("t-rebuild")).toEqual([]);
  await buildCacheEntry(meta("t-rebuild"));
  expect((await readCacheEntry("t-rebuild")).length).toBeGreaterThan(0);
});

test("never writes outside ~/.claude/htmlview", async () => {
  await buildCacheEntry(meta("t-path"));
  expect(cacheDir()).toContain("/.claude/htmlview/");
  await stat(join(cacheDir(), "t-path.txt")); // throws if absent
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/searchcache.test.ts`
Expected: FAIL — `Cannot find module './searchcache'`.

- [ ] **Step 3: Implement the cache**

```ts
// src/searchcache.ts
import { mkdir, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTranscript } from "./transcript";
import { listSessions, type SessionMeta } from "./sessions";
import { normalize } from "./normalize";

export type CacheLine = {
  turn: number;
  role: "user" | "assistant";
  original: string;
  normalized: string;
};

export const cacheDir = () => join(homedir(), ".claude", "htmlview", "cache");

const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
const unescape = (s: string) =>
  s.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));

/**
 * Extract only human and assistant prose. Tool inputs/outputs and thinking are
 * excluded: they are mostly file contents and would swamp search results.
 */
function extractLines(jsonl: string): string[] {
  const { turns } = parseTranscript(jsonl);
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.userText?.trim()) {
      out.push(`${turn.index}\tuser\t${escape(turn.userText)}`);
    }
    for (const b of turn.blocks) {
      if (b.kind === "text" && b.text.trim()) {
        out.push(`${turn.index}\tassistant\t${escape(b.text)}`);
      }
    }
  }
  return out;
}

export async function buildCacheEntry(session: SessionMeta): Promise<void> {
  const text = await Bun.file(session.file).text();
  await mkdir(cacheDir(), { recursive: true });
  await Bun.write(join(cacheDir(), `${session.id}.txt`), extractLines(text).join("\n"));
}

export async function readCacheEntry(sessionId: string): Promise<CacheLine[]> {
  const file = Bun.file(join(cacheDir(), `${sessionId}.txt`));
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines: CacheLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const tab1 = raw.indexOf("\t");
    const tab2 = raw.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const original = unescape(raw.slice(tab2 + 1));
    lines.push({
      turn: Number(raw.slice(0, tab1)),
      role: raw.slice(tab1 + 1, tab2) as "user" | "assistant",
      original,
      normalized: normalize(original),
    });
  }
  return lines;
}

/** Rebuild any cache entry whose source transcript is newer. Returns count rebuilt. */
export async function refreshCache(projectsDir?: string): Promise<number> {
  const sessions = await listSessions(projectsDir);
  await mkdir(cacheDir(), { recursive: true });
  let rebuilt = 0;
  for (const s of sessions) {
    const target = join(cacheDir(), `${s.id}.txt`);
    let cachedAt = 0;
    try {
      cachedAt = (await stat(target)).mtimeMs;
    } catch {
      cachedAt = 0; // absent -> rebuild
    }
    if (s.mtimeMs > cachedAt) {
      try {
        await buildCacheEntry(s);
        rebuilt++;
      } catch {
        continue; // source vanished mid-build; next refresh retries
      }
    }
  }
  return rebuilt;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/searchcache.test.ts`
Expected: PASS, `8 pass, 0 fail`.

- [ ] **Step 5: Verify cache size against the real corpus**

The spec predicts the cache is 5–10% of the raw transcripts, which is what makes a linear scan viable. Run:

```bash
bun -e 'import { refreshCache, cacheDir } from "./src/searchcache";
console.log("rebuilt:", await refreshCache());' \
  && du -sh ~/.claude/projects ~/.claude/htmlview/cache
```

Expected: `rebuilt: 84`, and the cache well under 20MB against 149MB of transcripts. If the cache is above ~30MB, tool content is leaking in — check `extractLines`.

- [ ] **Step 6: Commit**

```bash
git add src/searchcache.ts src/searchcache.test.ts
git commit -m "feat: derived plain-text search cache"
```

---

## Task 7: Search

**Files:**
- Create: `src/search.ts`
- Test: `src/search.test.ts`

**Interfaces:**
- Consumes: `readCacheEntry`/`CacheLine` (Task 6), `listSessions`/`SessionMeta` (Task 5), `normalize` (Task 2)
- Produces:
  ```ts
  export type Hit = {
    sessionId: string; project: string; title: string; turn: number;
    role: "user" | "assistant"; snippet: string;
    matchStart: number; matchEnd: number; mtimeMs: number;
  };
  export function makeSnippet(line: CacheLine, query: string, radius?: number): Omit<Hit, "sessionId"|"project"|"title"|"mtimeMs"> | null;
  export function search(query: string, projectsDir?: string): Promise<Hit[]>;
  ```
  Used by `server.ts` (Task 9).

**Offset contract:** `matchStart`/`matchEnd` index into `snippet`, not into the full original text. Normalization is length-preserving for every rule except digit folding and tashkeel/tatweel removal — both of which *shrink* text — so offsets are computed by locating the match in the normalized string and mapping back via an index table built during normalization of that single line.

- [ ] **Step 1: Write the failing tests**

```ts
// src/search.test.ts
import { test, expect } from "bun:test";
import { makeSnippet } from "./search";
import type { CacheLine } from "./searchcache";
import { normalize } from "./normalize";

const line = (original: string): CacheLine => ({
  turn: 3, role: "assistant", original, normalized: normalize(original),
});

test("finds a plain Latin match", () => {
  const r = makeSnippet(line("we fixed the docmost import today"), "docmost");
  expect(r).not.toBeNull();
  expect(r!.snippet.slice(r!.matchStart, r!.matchEnd).toLowerCase()).toBe("docmost");
});

test("is case-insensitive", () => {
  expect(makeSnippet(line("Fix the DocMost import"), "docmost")).not.toBeNull();
});

test("the motivating case: مشكله finds مُشْكِلَة", () => {
  const r = makeSnippet(line("هذه مُشْكِلَة كبيرة"), "مشكله");
  expect(r).not.toBeNull();
});

test("snippet shows original text, not normalized text", () => {
  const r = makeSnippet(line("هذه مُشْكِلَة كبيرة"), "مشكله");
  expect(r!.snippet).toContain("مُشْكِلَة");
});

test("match offsets point at the right substring of the original", () => {
  const r = makeSnippet(line("هذه مُشْكِلَة كبيرة"), "مشكله");
  expect(r!.snippet.slice(r!.matchStart, r!.matchEnd)).toBe("مُشْكِلَة");
});

test("returns null when there is no match", () => {
  expect(makeSnippet(line("nothing relevant here"), "docmost")).toBeNull();
});

test("truncates long lines around the match", () => {
  const r = makeSnippet(line("x".repeat(500) + " docmost " + "y".repeat(500)), "docmost", 40);
  expect(r!.snippet.length).toBeLessThan(140);
  expect(r!.snippet.slice(r!.matchStart, r!.matchEnd)).toBe("docmost");
});

test("carries the turn index through for deep linking", () => {
  expect(makeSnippet(line("docmost"), "docmost")!.turn).toBe(3);
});

test("empty query returns null rather than matching everything", () => {
  expect(makeSnippet(line("anything"), "")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/search.test.ts`
Expected: FAIL — `Cannot find module './search'`.

- [ ] **Step 3: Implement search**

```ts
// src/search.ts
import { normalize } from "./normalize";
import { readCacheEntry, type CacheLine } from "./searchcache";
import { listSessions } from "./sessions";

export type Hit = {
  sessionId: string;
  project: string;
  title: string;
  turn: number;
  role: "user" | "assistant";
  snippet: string;
  matchStart: number;
  matchEnd: number;
  mtimeMs: number;
};

/**
 * Normalize while recording, for each output character, the index of the source
 * character it came from. Lets a match found in normalized space be mapped back
 * onto the original text, which is what the user actually sees.
 */
function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const out = normalize(text[i]);
    for (const ch of out) {
      normalized += ch;
      map.push(i);
    }
  }
  return { normalized, map };
}

export function makeSnippet(
  line: CacheLine,
  query: string,
  radius = 90
): Pick<Hit, "turn" | "role" | "snippet" | "matchStart" | "matchEnd"> | null {
  const q = normalize(query).trim();
  if (!q) return null;

  const { normalized, map } = normalizeWithMap(line.original);
  const at = normalized.indexOf(q);
  if (at < 0) return null;

  // Map normalized-space match bounds back into original-string indices.
  const origStart = map[at] ?? 0;
  const lastIdx = Math.min(at + q.length - 1, map.length - 1);
  const origEnd = (map[lastIdx] ?? origStart) + 1;

  const from = Math.max(0, origStart - radius);
  const to = Math.min(line.original.length, origEnd + radius);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < line.original.length ? "…" : "";
  const snippet = prefix + line.original.slice(from, to) + suffix;

  return {
    turn: line.turn,
    role: line.role,
    snippet,
    matchStart: prefix.length + (origStart - from),
    matchEnd: prefix.length + (origEnd - from),
  };
}

export async function search(query: string, projectsDir?: string): Promise<Hit[]> {
  const q = normalize(query).trim();
  if (!q) return [];

  const sessions = await listSessions(projectsDir); // already sorted newest-first
  const hits: Hit[] = [];
  for (const session of sessions) {
    for (const line of await readCacheEntry(session.id)) {
      if (!line.normalized.includes(q)) continue; // cheap reject before the expensive map
      const snippet = makeSnippet(line, query);
      if (!snippet) continue;
      hits.push({
        ...snippet,
        sessionId: session.id,
        project: session.project,
        title: session.title,
        mtimeMs: session.mtimeMs,
      });
    }
  }
  return hits; // recency order inherited from listSessions
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/search.test.ts`
Expected: PASS, `9 pass, 0 fail`.

- [ ] **Step 5: Verify search against the real corpus**

Run:
```bash
bun -e '
import { search } from "./src/search";
const t0 = Date.now();
const hits = await search("docmost");
console.log("hits:", hits.length, "in", Date.now() - t0, "ms");
console.log(hits.slice(0, 3).map(h => `${h.project} | ${h.title} | turn ${h.turn} | ${h.snippet.slice(0, 60)}`));
'
```
Expected: a non-zero hit count returning in well under 2 seconds. If it takes longer than ~3s, the cache is too large — revisit Task 6 Step 5.

- [ ] **Step 6: Commit**

```bash
git add src/search.ts src/search.test.ts
git commit -m "feat: full-text search with Arabic-aware snippet offsets"
```

---

## Task 8: Filesystem watcher

**Files:**
- Create: `src/watch.ts`
- Test: `src/watch.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately decoupled — emits paths, not parsed data)
- Produces:
  ```ts
  export type WatchHandle = { close(): void };
  export function watchProjects(projectsDir: string, onChange: (sessionId: string) => void, debounceMs?: number): Promise<WatchHandle>;
  ```
  Used by `server.ts` (Task 9).

**Watch strategy:** one watcher on the projects dir (to catch new project dirs) plus one per project dir. Two levels, never recursive — recursive `fs.watch` support varies by platform, and going deeper would pick up subagent directories.

- [ ] **Step 1: Write the failing tests**

```ts
// src/watch.test.ts
import { test, expect } from "bun:test";
import { watchProjects } from "./watch";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("fires when a session file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlview-w-"));
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "sess-1.jsonl"), "{}\n");

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 20);
  await sleep(50);
  await writeFile(join(proj, "sess-1.jsonl"), '{}\n{"a":1}\n');
  await sleep(200);
  handle.close();

  expect(seen).toContain("sess-1");
});

test("debounces a burst of writes into one event", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlview-w-"));
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "sess-2.jsonl"), "{}\n");

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 60);
  await sleep(50);
  for (let i = 0; i < 5; i++) {
    await writeFile(join(proj, "sess-2.jsonl"), `{"n":${i}}\n`);
    await sleep(5);
  }
  await sleep(250);
  handle.close();

  expect(seen.filter((s) => s === "sess-2").length).toBe(1);
});

test("ignores non-jsonl files", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlview-w-"));
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 20);
  await sleep(50);
  await writeFile(join(proj, "notes.txt"), "hello");
  await sleep(200);
  handle.close();

  expect(seen.length).toBe(0);
});

test("close() stops delivering events", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlview-w-"));
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 20);
  await sleep(50);
  handle.close();
  await writeFile(join(proj, "sess-3.jsonl"), "{}\n");
  await sleep(200);

  expect(seen.length).toBe(0);
});

test("does not throw on a missing projects dir", async () => {
  const handle = await watchProjects("/nonexistent/xyz", () => {}, 20);
  handle.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/watch.test.ts`
Expected: FAIL — `Cannot find module './watch'`.

- [ ] **Step 3: Implement the watcher**

```ts
// src/watch.ts
import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type WatchHandle = { close(): void };

/**
 * Watch ~/.claude/projects two levels deep: the root (for new project dirs)
 * plus one watcher per project dir (for session files). Never recursive —
 * recursive support varies by platform, and deeper levels are subagent
 * transcripts, which are out of scope.
 */
export async function watchProjects(
  projectsDir: string,
  onChange: (sessionId: string) => void,
  debounceMs = 120
): Promise<WatchHandle> {
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const emit = (sessionId: string) => {
    if (closed) return;
    clearTimeout(timers.get(sessionId));
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        if (!closed) onChange(sessionId);
      }, debounceMs)
    );
  };

  const watchProject = (dir: string) => {
    try {
      watchers.push(
        watch(dir, (_event, filename) => {
          if (!filename || !filename.endsWith(".jsonl")) return;
          emit(filename.slice(0, -".jsonl".length));
        })
      );
    } catch {
      // dir vanished between listing and watching — ignore
    }
  };

  let entries: string[] = [];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { close() {} }; // missing projects dir — nothing to watch
  }

  for (const name of entries) watchProject(join(projectsDir, name));

  // Root watcher: pick up project dirs created after startup.
  try {
    watchers.push(
      watch(projectsDir, (_event, filename) => {
        if (!filename || filename.endsWith(".jsonl")) return;
        watchProject(join(projectsDir, filename));
      })
    );
  } catch {
    // ignore
  }

  return {
    close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) {
        try {
          w.close();
        } catch {}
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/watch.test.ts`
Expected: PASS, `5 pass, 0 fail`.

- [ ] **Step 5: Verify watcher count against the real dir**

The spec predicts ~18 watchers, well under any inotify limit. Run:

```bash
bun -e '
import { watchProjects } from "./src/watch";
import { readdir } from "node:fs/promises";
const dir = `${process.env.HOME}/.claude/projects`;
const dirs = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).length;
console.log("project dirs:", dirs, "-> watchers:", dirs + 1);
const h = await watchProjects(dir, id => console.log("changed:", id));
setTimeout(() => { h.close(); console.log("ok, closed cleanly"); }, 1500);
'
```
Expected: `project dirs: 17 -> watchers: 18`, then `ok, closed cleanly`. If the process hangs after `closed cleanly`, a watcher is leaking.

- [ ] **Step 6: Commit**

```bash
git add src/watch.ts src/watch.test.ts
git commit -m "feat: two-level debounced filesystem watcher"
```

---

## Task 9: Server and JSON API

**Files:**
- Create: `src/server.ts`
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: `listSessions`/`newestSession` (Task 5), `parseTranscript` (Task 4), `search` (Task 7), `refreshCache` (Task 6), `watchProjects` (Task 8)
- Produces: HTTP routes consumed by `public/app.js` (Task 11)

**Routes:**

| Route | Returns |
|---|---|
| `GET /api/sessions` | `SessionMeta[]`, newest first |
| `GET /api/session/:id?before=<n>&limit=<n>` | `{ meta, turns, hasMore }` — last `limit` turns, paginating backwards |
| `GET /api/search?q=` | `Hit[]` |
| `GET /api/artifacts` | `Artifact[]` |
| `GET /events` | SSE, `data: {"sessionId": "..."}` per change |
| `GET /live` | 302 to `/s/<newest session id>` |
| `GET /`, `/s/:id`, `/search`, `/artifacts` | `public/index.html` |
| `GET /<static>` | files from `public/` |

- [ ] **Step 1: Write the failing tests**

```ts
// src/server.test.ts
import { test, expect } from "bun:test";
import { createServer } from "./server";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixtureServer() {
  const root = await mkdtemp(join(tmpdir(), "htmlview-s-"));
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(
    join(proj, "sess-a.jsonl"),
    await Bun.file("src/fixtures/basic.jsonl").text()
  );
  const server = await createServer({ projectsDir: root, port: 0 });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

test("binds to 127.0.0.1 and never 0.0.0.0", async () => {
  const { server } = await fixtureServer();
  expect(server.hostname).toBe("127.0.0.1");
  server.stop();
});

test("GET /api/sessions lists sessions", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/api/sessions`);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.length).toBe(1);
  expect(body[0].title).toBe("Check the font setup");
  server.stop();
});

test("GET /api/session/:id returns turns", async () => {
  const { server, base } = await fixtureServer();
  const body = await (await fetch(`${base}/api/session/sess-a`)).json();
  expect(body.turns.length).toBe(2);
  expect(body.meta.id).toBe("sess-a");
  server.stop();
});

test("GET /api/session/:id paginates from the end", async () => {
  const { server, base } = await fixtureServer();
  const body = await (await fetch(`${base}/api/session/sess-a?limit=1`)).json();
  expect(body.turns.length).toBe(1);
  expect(body.turns[0].index).toBe(1); // the LAST turn, not the first
  expect(body.hasMore).toBe(true);
  server.stop();
});

test("GET /api/session/:id 404s for an unknown id", async () => {
  const { server, base } = await fixtureServer();
  expect((await fetch(`${base}/api/session/nope`)).status).toBe(404);
  server.stop();
});

test("GET /api/search returns hits", async () => {
  const { server, base } = await fixtureServer();
  const body = await (await fetch(`${base}/api/search?q=fonts`)).json();
  expect(Array.isArray(body)).toBe(true);
  server.stop();
});

test("GET /api/search with an empty query returns an empty array", async () => {
  const { server, base } = await fixtureServer();
  expect(await (await fetch(`${base}/api/search?q=`)).json()).toEqual([]);
  server.stop();
});

test("GET /live redirects to the newest session", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/live`, { redirect: "manual" });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/s/sess-a");
  server.stop();
});

test("GET /events opens an SSE stream", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/events`);
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  await r.body?.cancel();
  server.stop();
});

test("unknown app routes serve the HTML shell", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/s/anything`);
  expect(r.headers.get("content-type")).toContain("text/html");
  server.stop();
});

test("path traversal in static serving is rejected", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/../../../../etc/passwd`);
  expect(r.status).toBeGreaterThanOrEqual(400);
  server.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/server.test.ts`
Expected: FAIL — `Cannot find module './server'`.

- [ ] **Step 3: Implement the server**

```ts
// src/server.ts
import { join, normalize as pathNormalize } from "node:path";
import { listSessions, newestSession, defaultProjectsDir } from "./sessions";
import { parseTranscript } from "./transcript";
import { search } from "./search";
import { refreshCache } from "./searchcache";
import { watchProjects } from "./watch";
import { listArtifacts } from "./artifacts";

const PUBLIC = join(import.meta.dir, "..", "public");
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export type ServerOptions = { projectsDir?: string; port?: number };

export async function createServer(opts: ServerOptions = {}) {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const clients = new Set<(sessionId: string) => void>();

  const server = Bun.serve({
    hostname: "127.0.0.1", // never 0.0.0.0 — transcripts contain secrets
    port: opts.port ?? 7317,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/sessions") return json(await listSessions(projectsDir));

      if (path.startsWith("/api/session/")) {
        const id = decodeURIComponent(path.slice("/api/session/".length));
        const meta = (await listSessions(projectsDir)).find((s) => s.id === id);
        if (!meta) return json({ error: "not found" }, 404);
        const { turns } = parseTranscript(await Bun.file(meta.file).text());
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const before = Number(url.searchParams.get("before") ?? turns.length);
        const start = Math.max(0, before - limit);
        return json({ meta, turns: turns.slice(start, before), hasMore: start > 0 });
      }

      if (path === "/api/search") {
        return json(await search(url.searchParams.get("q") ?? "", projectsDir));
      }

      if (path === "/api/artifacts") return json(await listArtifacts());

      if (path === "/events") {
        const stream = new ReadableStream({
          start(controller) {
            const send = (sessionId: string) =>
              controller.enqueue(`data: ${JSON.stringify({ sessionId })}\n\n`);
            clients.add(send);
            controller.enqueue(": connected\n\n");
            req.signal.addEventListener("abort", () => {
              clients.delete(send);
              try {
                controller.close();
              } catch {}
            });
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      if (path === "/live") {
        const newest = await newestSession(projectsDir);
        return new Response(null, {
          status: 302,
          headers: { location: newest ? `/s/${newest.id}` : "/" },
        });
      }

      // Static assets. Reject traversal before touching the filesystem.
      if (path !== "/" && !path.startsWith("/s/") && path !== "/search" && path !== "/artifacts") {
        const rel = pathNormalize(path).replace(/^(\.\.[/\\])+/, "");
        if (rel.includes("..")) return new Response("forbidden", { status: 403 });
        const file = Bun.file(join(PUBLIC, rel));
        if (await file.exists()) return new Response(file);
      }

      return new Response(Bun.file(join(PUBLIC, "index.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const watcher = await watchProjects(projectsDir, (sessionId) => {
    for (const send of clients) {
      try {
        send(sessionId);
      } catch {
        clients.delete(send);
      }
    }
  });

  const originalStop = server.stop.bind(server);
  server.stop = ((...args: any[]) => {
    watcher.close();
    return originalStop(...args);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 7317;
  const server = await createServer({ port });
  console.log(`claude-htmlview  http://127.0.0.1:${server.port}`);
  console.log(`  live view       http://127.0.0.1:${server.port}/live`);
  const rebuilt = await refreshCache();
  console.log(`  search cache    ${rebuilt} session(s) indexed`);
}
```

- [ ] **Step 4: Create the artifact module it imports**

`server.ts` imports `listArtifacts`. Create it now so the server compiles; Task 12 builds on it.

```ts
// src/artifacts.ts
import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { decodeProject } from "./sessions";

export type Artifact = {
  name: string;
  project: string;
  href: string;
  file: string;
  mtimeMs: number;
};

export const artifactsDir = () => join(homedir(), ".claude", "htmlview", "artifacts");

export async function listArtifacts(): Promise<Artifact[]> {
  const out: Artifact[] = [];
  try {
    for await (const file of new Glob("*/*.html").scan({
      cwd: artifactsDir(),
      absolute: true,
    })) {
      const dirName = basename(dirname(file));
      out.push({
        name: basename(file, ".html"),
        project: decodeProject(dirName),
        href: `/artifact/${dirName}/${basename(file)}`,
        file,
        mtimeMs: (await stat(file)).mtimeMs,
      });
    }
  } catch {
    return []; // no artifacts dir yet
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
```

- [ ] **Step 5: Create a minimal `public/index.html` so static routes resolve**

Task 10 replaces this. It exists now only so server tests can assert HTML is served.

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>claude-htmlview</title></head>
  <body><div id="app">loading…</div></body>
</html>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/server.test.ts`
Expected: PASS, `11 pass, 0 fail`.

- [ ] **Step 7: Verify the server starts against real data**

Run: `bun run start` in one terminal.
Expected output: the three startup lines, with `84 session(s) indexed`.

Then in another terminal:
```bash
curl -s http://127.0.0.1:7317/api/sessions | head -c 300
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:7317/live
```
Expected: a JSON array of sessions, then `302` with a `/s/<uuid>` redirect target. Stop the server with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/server.test.ts src/artifacts.ts public/index.html
git commit -m "feat: HTTP server with sessions, search, SSE, and live redirect"
```

---

## Task 10: Bidi rules

**Files:**
- Create: `public/bidi.js`
- Create: `public/style.css`
- Test: `src/bidi.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `applyBidi(root: Element): void` — global `window.applyBidi`, called by `public/app.js` (Task 11) after every markdown render

**This is the task that solves the motivating problem.** All six spec rules land here.

- [ ] **Step 1: Write the failing tests**

There is no DOM in Bun's test environment and jsdom would breach the zero-dependency constraint, so these tests assert **source contracts** — that the rules are present and no forbidden pattern appears. They cannot prove the UBA behaves correctly; only a real browser can, which is what Step 6 does. Treat these two steps as one verification, not as duplicates.

```ts
// src/bidi.test.ts
import { test, expect } from "bun:test";

test("bidi.js sets dir=auto on every block element type", async () => {
  const src = await Bun.file("public/bidi.js").text();
  for (const tag of ["p", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]) {
    expect(src).toContain(tag);
  }
  expect(src).toContain('"auto"');
});

test("bidi.js forces pre to LTR", async () => {
  const src = await Bun.file("public/bidi.js").text();
  expect(src).toMatch(/pre[\s\S]{0,200}ltr/);
});

test("style.css isolates inline code, links and strong", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).toContain("unicode-bidi: isolate");
  for (const sel of ["code", "a", "strong"]) expect(css).toContain(sel);
});

test("style.css uses text-align: start and never text-align: left", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).toContain("text-align: start");
  expect(css).not.toContain("text-align: left");
});

test("style.css includes the Arabic font stack", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).toContain("Noto Sans Arabic");
  expect(css).toContain("Iosevka NFM");
});

test("style.css gives RTL blocks looser line-height", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).toMatch(/\[dir=["']?rtl["']?\][\s\S]{0,200}line-height/);
});

test("style.css never loads external resources", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).not.toContain("@import");
  expect(css).not.toContain("http://");
  expect(css).not.toContain("https://");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/bidi.test.ts`
Expected: FAIL — the files do not exist.

- [ ] **Step 3: Write `public/bidi.js`**

```js
// public/bidi.js
// The six bidi rules from the spec. Applied after every markdown render.
//
// Rules 4-6 (font stack, text-align: start, RTL leading) live in style.css
// because they are purely declarative. Rules 1-3 need DOM traversal.

const BLOCK_SELECTOR = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt";

/**
 * Rule 1: dir="auto" on every block element. The browser's first-strong-character
 *   heuristic then resolves direction per block, with no tagging from the author.
 * Rule 2: <pre> forced dir="ltr". Code is LTR even inside Arabic prose; without
 *   this it flips and becomes unreadable.
 * Rule 3: inline isolation is applied via CSS (unicode-bidi: isolate) so that an
 *   English identifier inside an Arabic sentence cannot drag the surrounding
 *   punctuation to the wrong end.
 */
export function applyBidi(root) {
  if (!root) return;

  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    el.setAttribute("dir", "auto");
  }

  for (const pre of root.querySelectorAll("pre")) {
    pre.setAttribute("dir", "ltr");
  }

  // The root itself may be a block that needs direction resolved.
  if (root.matches && root.matches(BLOCK_SELECTOR)) {
    root.setAttribute("dir", "auto");
  }
}

if (typeof window !== "undefined") {
  window.applyBidi = applyBidi;
}
```

- [ ] **Step 4: Write `public/style.css`**

```css
/* public/style.css
   Rules 4-6 of the six bidi rules live here. No external resources: every font
   named is already installed locally, verified 2026-07-20. */

:root {
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic UI",
    "Noto Sans Arabic", sans-serif;
  --mono: "Iosevka NFM", "DejaVu Sans Mono", ui-monospace, monospace;
  --bg: #0f1115;
  --fg: #e6e6e6;
  --muted: #8b93a7;
  --line: #232733;
  --accent: #7aa2f7;
  --user-bg: #171a21;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #fbfbfd; --fg: #1a1a1a; --muted: #5c6478;
    --line: #e2e5ee; --user-bg: #f0f2f7;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.65;
  /* Rule 5: alignment follows dir automatically. Never text-align with a
     physical direction. */
  text-align: start;
}

/* Rule 6: Arabic diacritics and taller ascenders collide at Latin leading. */
[dir="rtl"] {
  line-height: 1.95;
  letter-spacing: 0;
}

/* Rule 3: isolation prevents an English identifier inside Arabic prose from
   dragging neighbouring punctuation to the wrong end of the line. */
code, a, strong, em, kbd, abbr {
  unicode-bidi: isolate;
}

/* Rule 2's declarative half: code is always LTR, and never wraps direction. */
pre {
  direction: ltr;
  unicode-bidi: isolate;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
  overflow-x: auto;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 88%, #fff 12%);
}

code { font-family: var(--mono); font-size: 0.92em; }
pre code { font-size: inherit; }

.wrap { max-width: 860px; margin: 0 auto; padding: 24px 20px 120px; }

header.top {
  position: sticky; top: 0; z-index: 10;
  display: flex; gap: 16px; align-items: center;
  padding: 12px 20px;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
header.top a { color: var(--muted); text-decoration: none; }
header.top a:hover, header.top a.active { color: var(--fg); }

.turn { padding: 8px 0 20px; border-bottom: 1px solid var(--line); }
.turn:target { animation: flash 1.4s ease-out; }
@keyframes flash {
  from { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  to { background: transparent; }
}

.user {
  background: var(--user-bg);
  border-inline-start: 3px solid var(--accent);
  padding: 10px 14px;
  border-radius: 0 8px 8px 0;
  margin-bottom: 14px;
  white-space: pre-wrap;
}

.tool { margin: 10px 0; }
.tool summary {
  cursor: pointer; color: var(--muted); font-size: 13px;
  font-family: var(--mono); padding: 4px 0;
}
.tool summary:hover { color: var(--fg); }
.tool .body { padding-inline-start: 14px; border-inline-start: 1px solid var(--line); }

.thinking { color: var(--muted); font-style: italic; }
.placeholder {
  color: var(--muted); font-family: var(--mono); font-size: 12px;
  border: 1px dashed var(--line); border-radius: 6px; padding: 6px 10px;
}

.session-row { display: block; padding: 10px 0; border-bottom: 1px solid var(--line);
  color: inherit; text-decoration: none; }
.session-row:hover { background: var(--user-bg); }
.session-row .meta { color: var(--muted); font-size: 12.5px; }

mark { background: color-mix(in srgb, var(--accent) 35%, transparent); color: inherit; }

input[type="search"] {
  width: 100%; padding: 10px 12px; font: inherit; text-align: start;
  background: var(--user-bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px;
}

.muted { color: var(--muted); }
.show-more { font: inherit; background: none; border: 0; color: var(--accent);
  cursor: pointer; padding: 4px 0; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/bidi.test.ts`
Expected: PASS, `7 pass, 0 fail`.

- [ ] **Step 6: Verify real bidi behaviour in a browser**

Source-contract tests cannot prove the UBA behaves correctly — only a real browser can. Create `public/bidi-check.html`:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><link rel="stylesheet" href="/style.css" /></head>
  <body class="wrap">
    <div id="t"></div>
    <script type="module">
      import { applyBidi } from "/bidi.js";
      document.getElementById("t").innerHTML = `
        <p>هذه مشكلة في الكود</p>
        <p>This is an English paragraph</p>
        <p>افتح الملف <code>server.ts</code> ثم أعد التشغيل.</p>
        <pre><code>const x = 1; // مثال</code></pre>
        <ul><li>عنصر عربي</li><li>English item</li></ul>`;
      applyBidi(document.getElementById("t"));
      window.__dirs = [...document.querySelectorAll("p,li,pre")]
        .map((e) => e.tagName + ":" + getComputedStyle(e).direction);
    </script>
  </body>
</html>
```

Start the server (`bun run start`), then use the Playwright MCP to open `http://127.0.0.1:7317/bidi-check.html` and evaluate `window.__dirs`.

Expected: `P:rtl` for the Arabic paragraphs, `P:ltr` for the English one, `PRE:ltr` for the code block, and `LI:rtl` / `LI:ltr` for the respective list items. Take a screenshot and confirm visually that the Arabic paragraph containing `server.ts` reads correctly — the inline code sits in the right place and the trailing full stop is at the left end, not stranded.

If the Arabic renders as disconnected letterforms, the font stack is not resolving; check `--sans` in `style.css`.

- [ ] **Step 7: Commit**

```bash
git add public/bidi.js public/style.css public/bidi-check.html src/bidi.test.ts
git commit -m "feat: six bidi rules fixing mixed Arabic/English rendering"
```

---

## Task 11: Client rendering

**Files:**
- Create: `public/vendor/marked.min.js`
- Modify: `public/index.html` (replace the Task 9 stub entirely)
- Create: `public/app.js`

**Interfaces:**
- Consumes: `applyBidi` from `public/bidi.js` (Task 10); the JSON routes from `src/server.ts` (Task 9)
- Produces: the finished reading surface

- [ ] **Step 1: Vendor `marked.js`**

Run:
```bash
mkdir -p public/vendor
curl -fsSL https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js -o public/vendor/marked.min.js
ls -la public/vendor/marked.min.js
```
Expected: a file around 40–50KB. This is the **only** vendored third-party file. It is committed to the repo, not fetched at runtime — the page must work offline.

- [ ] **Step 2: Verify the vendored file is self-contained**

Run:
```bash
grep -c 'https\?://' public/vendor/marked.min.js || echo "no external URLs"
bun -e 'const s = await Bun.file("public/vendor/marked.min.js").text();
console.log("has UMD export:", /marked/.test(s), "bytes:", s.length);'
```
Expected: no external URLs fetched at runtime (URLs in comments are fine), and a non-trivial byte count. If the download produced an HTML error page instead, the byte count will be tiny — re-download.

- [ ] **Step 3: Write `public/index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>claude-htmlview</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <header class="top">
      <a href="/">sessions</a>
      <a href="/live">live</a>
      <a href="/search">search</a>
      <a href="/artifacts">artifacts</a>
      <span style="flex: 1"></span>
      <label class="muted" style="font-size: 13px">
        <input type="checkbox" id="show-thinking" /> thinking
      </label>
    </header>
    <main class="wrap" id="app">loading…</main>
    <script src="/vendor/marked.min.js"></script>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Write `public/app.js`**

```js
// public/app.js
import { applyBidi } from "/bidi.js";

const app = document.getElementById("app");
const TOOL_LIMIT = 4096; // spec: truncate tool output; largest observed is 46KB

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/** Markdown -> HTML, then the six bidi rules. Every render path goes through here. */
function md(text) {
  const div = document.createElement("div");
  div.innerHTML = marked.parse(text ?? "", { breaks: true });
  applyBidi(div);
  return div;
}

function toolNode(block) {
  const d = document.createElement("details");
  d.className = "tool";
  const summary = document.createElement("summary");
  summary.textContent = `${block.name}${block.summary ? " · " + block.summary : ""}`;
  d.append(summary);

  const body = document.createElement("div");
  body.className = "body";

  const input = document.createElement("pre");
  input.setAttribute("dir", "ltr");
  input.textContent = JSON.stringify(block.input, null, 2);
  body.append(input);

  if (block.result != null) {
    const full = String(block.result);
    const out = document.createElement("pre");
    out.setAttribute("dir", "ltr");
    out.textContent = full.slice(0, TOOL_LIMIT);
    body.append(out);
    if (full.length > TOOL_LIMIT) {
      const more = document.createElement("button");
      more.className = "show-more";
      more.textContent = `show all ${full.length.toLocaleString()} chars`;
      more.onclick = () => {
        out.textContent = full;
        more.remove();
      };
      body.append(more);
    }
  }
  d.append(body);
  return d;
}

function turnNode(turn) {
  const section = document.createElement("section");
  section.className = "turn";
  section.id = `turn-${turn.index}`;

  if (turn.userText) {
    const u = document.createElement("div");
    u.className = "user";
    u.setAttribute("dir", "auto"); // rule 1, for the non-markdown user block
    u.textContent = turn.userText;
    section.append(u);
  }

  const showThinking = document.getElementById("show-thinking").checked;
  for (const b of turn.blocks) {
    if (b.kind === "text") section.append(md(b.text));
    else if (b.kind === "thinking" && showThinking) {
      const t = md(b.text);
      t.className = "thinking";
      section.append(t);
    } else if (b.kind === "tool") section.append(toolNode(b));
    else if (b.kind === "unknown") {
      const p = document.createElement("div");
      p.className = "placeholder";
      p.textContent = `unrendered entry type: ${b.entryType}`;
      section.append(p);
    }
  }
  return section;
}

const atBottom = () =>
  window.innerHeight + window.scrollY >= document.body.offsetHeight - 120;

async function renderIndex() {
  const sessions = await (await fetch("/api/sessions")).json();
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  app.replaceChildren();
  for (const [project, list] of byProject) {
    const h = document.createElement("h2");
    h.textContent = project;
    h.setAttribute("dir", "auto");
    app.append(h);
    for (const s of list) {
      const a = document.createElement("a");
      a.className = "session-row";
      a.href = `/s/${s.id}`;
      const title = document.createElement("div");
      title.setAttribute("dir", "auto");
      title.textContent = s.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${s.turnCount} turns · ${new Date(s.mtimeMs).toLocaleString()}`;
      a.append(title, meta);
      app.append(a);
    }
  }
}

let currentSession = null;

async function renderThread(id) {
  currentSession = id;
  const data = await (await fetch(`/api/session/${encodeURIComponent(id)}`)).json();
  if (data.error) {
    app.textContent = "session not found";
    return;
  }
  const h = document.createElement("h1");
  h.setAttribute("dir", "auto");
  h.textContent = data.meta.title;
  const sub = document.createElement("div");
  sub.className = "muted";
  sub.textContent = data.meta.project;
  app.replaceChildren(h, sub);

  if (data.hasMore) {
    const more = document.createElement("button");
    more.className = "show-more";
    more.textContent = "load earlier turns";
    more.onclick = async () => {
      const first = data.turns[0].index;
      const older = await (
        await fetch(`/api/session/${encodeURIComponent(id)}?before=${first}`)
      ).json();
      const anchor = more.nextSibling;
      for (const t of older.turns) app.insertBefore(turnNode(t), anchor);
      if (!older.hasMore) more.remove();
      data.turns = older.turns.concat(data.turns);
    };
    app.append(more);
  }

  for (const t of data.turns) app.append(turnNode(t));

  if (location.hash) {
    document.querySelector(location.hash)?.scrollIntoView();
  } else {
    window.scrollTo(0, document.body.scrollHeight);
  }
}

async function renderSearch() {
  const q = new URLSearchParams(location.search).get("q") ?? "";
  const box = document.createElement("input");
  box.type = "search";
  box.value = q;
  box.placeholder = "search all sessions — يعمل بالعربية أيضا";
  box.setAttribute("dir", "auto");
  box.onkeydown = (e) => {
    if (e.key === "Enter") {
      history.pushState({}, "", `/search?q=${encodeURIComponent(box.value)}`);
      route();
    }
  };
  app.replaceChildren(box);
  box.focus();
  if (!q) return;

  const hits = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  const count = document.createElement("p");
  count.className = "muted";
  count.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}`;
  app.append(count);

  for (const hit of hits) {
    const a = document.createElement("a");
    a.className = "session-row";
    a.href = `/s/${hit.sessionId}#turn-${hit.turn}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${hit.project} · ${hit.title} · turn ${hit.turn}`;
    const snip = document.createElement("div");
    snip.setAttribute("dir", "auto"); // rule 1 applies to snippets too
    snip.append(
      document.createTextNode(hit.snippet.slice(0, hit.matchStart))
    );
    const mark = document.createElement("mark");
    mark.textContent = hit.snippet.slice(hit.matchStart, hit.matchEnd);
    snip.append(mark, document.createTextNode(hit.snippet.slice(hit.matchEnd)));
    a.append(meta, snip);
    app.append(a);
  }
}

async function renderArtifacts() {
  const items = await (await fetch("/api/artifacts")).json();
  app.replaceChildren();
  if (!items.length) {
    app.innerHTML = `<p class="muted">No artifacts yet. Ask Claude to make one.</p>`;
    return;
  }
  for (const a of items) {
    const row = document.createElement("a");
    row.className = "session-row";
    row.href = a.href;
    row.innerHTML = `<div>${esc(a.name)}</div>
      <div class="meta">${esc(a.project)} · ${new Date(a.mtimeMs).toLocaleString()}</div>`;
    app.append(row);
  }
}

function route() {
  const p = location.pathname;
  if (p.startsWith("/s/")) return renderThread(decodeURIComponent(p.slice(3)));
  if (p === "/search") return renderSearch();
  if (p === "/artifacts") return renderArtifacts();
  return renderIndex();
}

// Intercept internal links so navigation does not reload the page.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a");
  if (!a || a.target || !a.href.startsWith(location.origin)) return;
  if (a.pathname.startsWith("/artifact/")) return; // real navigation to the file
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  route();
});
window.addEventListener("popstate", route);
document.getElementById("show-thinking").addEventListener("change", route);

// Live updates. Re-render only when the change concerns the open session, and
// only auto-scroll if the reader is already at the bottom.
new EventSource("/events").onmessage = async (e) => {
  const { sessionId } = JSON.parse(e.data);
  if (sessionId !== currentSession) return;
  const wasAtBottom = atBottom();
  await renderThread(sessionId);
  if (wasAtBottom) window.scrollTo(0, document.body.scrollHeight);
};

route();
```

- [ ] **Step 5: Verify the reading surface in a browser**

Start the server (`bun run start`). Using the Playwright MCP:

1. Open `http://127.0.0.1:7317/` — confirm sessions are grouped by project with real titles.
2. Open `http://127.0.0.1:7317/live` — confirm it lands on a thread and scrolls to the bottom.
3. Confirm tool calls appear collapsed, and that expanding one shows input and output.
4. Open `http://127.0.0.1:7317/search?q=docmost` — confirm hits with highlighted matches, and that clicking one deep-links to the right turn and flashes it.
5. Search for an Arabic term you have used and confirm the snippet reads correctly.
6. Screenshot a thread containing Arabic and confirm the rendering is readable — this is the whole point of the project.

- [ ] **Step 6: Verify live updates end-to-end**

With the server running and `/live` open in the browser, run a short Claude Code session in another terminal. Confirm the browser appends the new turn without a manual refresh, and that scrolling up to read history is not yanked back down by an incoming update.

- [ ] **Step 7: Commit**

```bash
git add public/vendor/marked.min.js public/index.html public/app.js
git commit -m "feat: client rendering with collapsed tools, search, and live updates"
```

---

## Task 12: Artifact library and skill

**Files:**
- Modify: `src/server.ts` (add the `/artifact/` static route)
- Create: `src/artifacts.test.ts`
- Create: `~/.claude/skills/htmlview-artifact/SKILL.md`

**Interfaces:**
- Consumes: `listArtifacts`/`artifactsDir` from `src/artifacts.ts` (created in Task 9)
- Produces: browsable artifacts and the skill that tells Claude when to write one

- [ ] **Step 1: Write the failing test**

```ts
// src/artifacts.test.ts
import { test, expect } from "bun:test";
import { createServer } from "./server";
import { artifactsDir } from "./artifacts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

test("serves an artifact file and lists it", async () => {
  const dir = join(artifactsDir(), "-home-taha-demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "test-artifact.html"), "<h1>hello artifact</h1>");

  const server = await createServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;

  const list = await (await fetch(`${base}/api/artifacts`)).json();
  expect(list.some((a: any) => a.name === "test-artifact")).toBe(true);

  const page = await fetch(`${base}/artifact/-home-taha-demo/test-artifact.html`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("hello artifact");

  server.stop();
  await rm(join(dir, "test-artifact.html"), { force: true });
});

test("artifact route rejects path traversal", async () => {
  const server = await createServer({ port: 0 });
  const r = await fetch(
    `http://127.0.0.1:${server.port}/artifact/..%2f..%2f..%2f..%2fetc%2fpasswd`
  );
  expect(r.status).toBeGreaterThanOrEqual(400);
  server.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/artifacts.test.ts`
Expected: FAIL — the `/artifact/` route 404s or serves the HTML shell.

- [ ] **Step 3: Add the artifact route to `src/server.ts`**

Insert immediately before the `// Static assets.` comment:

```ts
      if (path.startsWith("/artifact/")) {
        const rel = decodeURIComponent(path.slice("/artifact/".length));
        // Reject traversal before touching the filesystem.
        if (rel.includes("..") || rel.startsWith("/")) {
          return new Response("forbidden", { status: 403 });
        }
        const file = Bun.file(join(artifactsDir(), rel));
        if (await file.exists()) {
          return new Response(file, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      }
```

Add `artifactsDir` to the existing import:

```ts
import { listArtifacts, artifactsDir } from "./artifacts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/artifacts.test.ts`
Expected: PASS, `2 pass, 0 fail`.

- [ ] **Step 5: Write the skill**

Create `~/.claude/skills/htmlview-artifact/SKILL.md`:

```markdown
---
name: htmlview-artifact
description: Use when output would be substantially clearer as a standalone HTML page than as terminal markdown - comparisons of three or more options, specs, code reviews with per-item severity, anything needing a diagram, or an interactive parameter tuner. Writes a self-contained HTML artifact to the claude-htmlview library.
---

# Writing an HTML artifact

Write a self-contained HTML file to:

`~/.claude/htmlview/artifacts/<encoded-project>/<YYYY-MM-DD-HHmm>-<slug>.html`

`<encoded-project>` is the cwd with `/` replaced by `-`, matching Claude Code's
own convention (`/home/taha/github/docmost` -> `-home-taha-github-docmost`).

Browse artifacts at `http://127.0.0.1:7317/artifacts`.

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

- **Self-contained.** No CDN scripts, no external stylesheets, no remote fonts
  or images. The page must render with no network.
- **Bidi-safe.** Set `dir="auto"` on every block element, force `dir="ltr"` on
  `<pre>`, and set `unicode-bidi: isolate` on inline `code`, `a`, and `strong`.
  Use `text-align: start`, never `left`. Content is frequently mixed
  Arabic/English and must remain readable.
- **Local fonts only.** `"Noto Sans Arabic UI"` after the Latin sans;
  `"Iosevka NFM", "DejaVu Sans Mono"` for monospace. All are installed.
- **Export button on anything interactive.** Any editor or tuner ends with a
  "copy as JSON" or "copy as prompt" button, so adjustments can flow back into
  a prompt or into version control.
- **Announce the path.** After writing, print the artifact path and its
  `http://127.0.0.1:7317/artifact/...` URL so it can be opened directly.
```

- [ ] **Step 6: Verify the skill is discoverable and produces a working artifact**

Run: `ls ~/.claude/skills/htmlview-artifact/SKILL.md`
Expected: the file exists.

Then start a **fresh** Claude Code session and ask for something that should trigger it, e.g. "compare four approaches to X and make me an HTML artifact". Confirm the skill is invoked, the file lands under `~/.claude/htmlview/artifacts/`, and it appears at `http://127.0.0.1:7317/artifacts`.

Open the artifact and confirm it renders with no network access — the surest check is to disable the network briefly, or confirm no external URLs appear in the file:
```bash
grep -oE 'https?://[^"'"'"' ]+' ~/.claude/htmlview/artifacts/*/*.html | head
```
Expected: no output, or only URLs inside comments.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/artifacts.test.ts
git commit -m "feat: artifact library route and htmlview-artifact skill"
```

---

## Task 13: Full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: a verified, documented, running system

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: all tests pass across every `src/*.test.ts`. Record the actual counts; do not claim success without reading the output.

- [ ] **Step 2: Confirm the zero-dependency constraint holds**

Run:
```bash
bun -e 'const p = await Bun.file("package.json").json();
console.log("dependencies:", p.dependencies ?? "none");
console.log("devDependencies:", p.devDependencies ?? "none");'
ls node_modules 2>/dev/null && echo "UNEXPECTED node_modules" || echo "no node_modules — correct"
```
Expected: `none` for both, and no `node_modules`.

- [ ] **Step 3: Confirm the read-only invariant held**

Run:
```bash
find ~/.claude/projects -newermt '-2 hours' -type f | head
```
Expected: only files genuinely written by Claude Code sessions run during development. **No file this project touched.** If anything unexpected appears, a write path leaked — find it before continuing.

- [ ] **Step 4: Confirm localhost-only binding**

Start the server, then run:
```bash
ss -ltnp 2>/dev/null | grep 7317 || netstat -ltnp 2>/dev/null | grep 7317
```
Expected: the listen address is `127.0.0.1:7317`, **never** `0.0.0.0:7317` or `*:7317`.

- [ ] **Step 5: Update `README.md` with real usage**

Replace the `## Run` section with measured facts — actual session count, actual cache size, actual startup time. Add a `## What it does not do` section listing the deferred items from the spec (browser-side input, server-side markdown rendering, search over tool output, ranked search), so future readers do not re-litigate settled decisions.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: usage and verified constraints"
```

- [ ] **Step 7: Report honestly**

Summarize: what works, what was verified with which command, and anything that did not work or was left incomplete. Do not claim a step passed without having read its output.

---

## Self-Review Notes

**Spec coverage check** — every spec section maps to a task:

| Spec section | Task |
|---|---|
| Transcript format (verified) | 3, 4 |
| Definition of a turn | 4 |
| Units table | 2–9 |
| Stack (Bun, zero deps, vendored marked) | 1, 11, 13 |
| Six bidi rules | 10 |
| Route `/` | 9, 11 |
| Route `/s/:id` incl. collapsed tools, thinking toggle | 9, 11 |
| Route `/live` | 9 |
| Route `/artifacts` | 9, 12 |
| Route `/search` | 9, 11 |
| Derived text cache | 6 |
| Arabic normalization | 2 |
| Search results + deep link + flash | 7, 10, 11 |
| Live updates + scroll-follow | 9, 11 |
| Tool truncation at 4KB | 11 |
| Thread pagination from the end | 9, 11 |
| Artifact library + cross-linking | 12 |
| Artifact trigger skill | 12 |
| Malformed-line tolerance | 4 |
| Two-level watch strategy | 8 |
| Port fallback, deleted files, empty transcripts, unknown types | 4, 5, 9 |
| Security: 127.0.0.1, no auth | 9, 13 |
| Testing approach | every task |

**Known gap, deliberately accepted:** the spec calls for bidirectional artifact cross-linking (thread → artifact *and* artifact → thread). Task 12 implements artifact → library listing, but **thread → artifact inline cards are not implemented**, because the transcript contains no reliable signal linking a written artifact back to the turn that produced it. Recording that link requires the skill to write a sidecar manifest — a scoped follow-up, not a v1 blocker. This is called out here rather than silently dropped.

**Type consistency check:** `SessionMeta`, `Turn`, `Block`, `CacheLine`, and `Hit` are defined once each and imported everywhere else. `decodeProject` is defined in `sessions.ts` and reused by `artifacts.ts`. `normalize` is defined in `normalize.ts` and used by both `searchcache.ts` and `search.ts`. No duplicated shapes.
