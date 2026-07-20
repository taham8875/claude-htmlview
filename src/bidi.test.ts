// src/bidi.test.ts
//
// There is no DOM in Bun's test environment, and jsdom would breach the
// zero-dependency constraint. So these tests assert source contracts -- that
// the rules are textually present, and no forbidden pattern appears. They
// cannot prove the Unicode Bidirectional Algorithm behaves correctly; only a
// real browser can (see public/bidi-check.html, driven manually / via
// Playwright, not part of `bun test`).
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
