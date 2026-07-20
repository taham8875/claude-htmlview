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

test("deduplicates assistant blocks sharing a message id", async () => {
  const p = await load("edge");
  const texts = p.turns[0].blocks.filter(
    (b) => b.kind === "text" && (b as any).text === "part one"
  );
  expect(texts.length).toBe(1);
});

test("handles array-valued tool_result content", async () => {
  const p = await load("edge");
  const tool = p.turns[0].blocks.find(
    (b) => b.kind === "tool" && (b as any).name === "Read"
  ) as any;
  expect(tool.result).toContain("file body");
});

test("represents images without base64 payload", async () => {
  const p = await load("edge");
  const json = JSON.stringify(p);
  expect(json).not.toContain("iVBORw0KGgo");
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
