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

// --- Extra coverage: astral-plane characters (emoji), which split into a
// surrogate pair under UTF-16 indexing. The offset map is built one UTF-16
// *code unit* at a time (not one code point at a time), so a naive reading
// might expect corruption here. Verify directly rather than assuming.

test("query itself containing an emoji matches without corrupting offsets", () => {
  const r = makeSnippet(line("great, ship it 🎉 today"), "🎉");
  expect(r).not.toBeNull();
  expect(r!.snippet.slice(r!.matchStart, r!.matchEnd)).toBe("🎉");
});

test("an emoji sitting right at the snippet truncation boundary is not split in half", () => {
  // Construct text so `from = origStart - radius` lands at index 1 -- inside
  // the emoji's surrogate pair (indices 0-1) -- and assert the snippet
  // contains no lone (unpaired) surrogate, which is what you'd see on screen
  // as a broken glyph if the truncation sliced through the pair.
  const radius = 10;
  const filler = "z".repeat(radius - 2);
  const text = "🎉" + filler + " docmost";
  const origStart = text.indexOf("docmost");
  expect(origStart - radius).toBe(1); // sanity: this construction actually targets the pair
  const r = makeSnippet(line(text), "docmost", radius);
  expect(r).not.toBeNull();
  // No lone surrogate anywhere in the produced snippet.
  for (let i = 0; i < r!.snippet.length; i++) {
    const code = r!.snippet.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) expect(r!.snippet.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
    if (isLow) expect(r!.snippet.charCodeAt(i - 1)).toBeGreaterThanOrEqual(0xd800);
  }
});

test("match spanning multiple tashkeel-shrunk source characters still yields a valid slice", () => {
  // Heavier diacritic load than the motivating case, and a query with digits
  // to also exercise Arabic-Indic digit folding within the same match.
  const r = makeSnippet(line("العدد ١٢٣ مُّشْكِلَةٌ حقيقية"), "123 مشكله");
  expect(r).not.toBeNull();
  expect(normalize(r!.snippet.slice(r!.matchStart, r!.matchEnd))).toBe(normalize("123 مشكله"));
});
