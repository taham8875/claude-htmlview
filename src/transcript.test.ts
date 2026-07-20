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
