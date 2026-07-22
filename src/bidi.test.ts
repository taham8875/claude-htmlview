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

// --- Tables -----------------------------------------------------------------
// Regression cover for two defects found against a real Arabic table:
// (1) tables were entirely unstyled, so cells ran together unreadably;
// (2) column ORDER ignored direction, because dir="auto" on a <table> is
//     defeated by the cells carrying their own dir. Measured in Chromium:
//     table dir="auto" with bare cells -> rtl; with dir="auto" cells -> ltr.

test("style.css gives table cells visible borders and real padding", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).toMatch(/\.turn th[\s\S]{0,80}\.turn td[\s\S]{0,200}border:\s*1px solid/);
  expect(css).toMatch(/\.turn th[\s\S]{0,80}\.turn td[\s\S]{0,200}padding:/);
  expect(css).toMatch(/\.turn table[\s\S]{0,200}border-collapse:\s*collapse/);
});

test("style.css lets wide tables scroll instead of stretching the page", async () => {
  const css = await Bun.file("public/style.css").text();
  expect(css).toMatch(/\.turn table[\s\S]{0,200}overflow-x:\s*auto/);
});

test("table styling uses logical properties, never physical directions", async () => {
  const css = await Bun.file("public/style.css").text();
  // A physical left/right here would fight dir and break RTL tables.
  expect(css).not.toMatch(/padding-(left|right)\s*:/);
  expect(css).not.toMatch(/border-(left|right)\s*:/);
  expect(css).not.toMatch(/text-align:\s*(left|right)/);
});

test("bidi.js resolves table direction explicitly rather than via dir=auto", async () => {
  const src = await Bun.file("public/bidi.js").text();
  // The explicit computation is the whole point: dir="auto" cannot work on a
  // table whose cells carry their own dir.
  expect(src).toContain("firstStrongDir");
  expect(src).toContain("applyTableDir");
  expect(src).toMatch(/querySelectorAll\("table"\)/);
  // ...and <table> must NOT be in the plain dir="auto" block list.
  const blockSelector = src.match(/const BLOCK_SELECTOR\s*=\s*[\s\S]*?;/)?.[0] ?? "";
  expect(blockSelector).not.toContain("table");
});

test("bidi.js recognises Arabic and Latin as strongly directional", async () => {
  const src = await Bun.file("public/bidi.js").text();
  const rtl = src.match(/const RTL_STRONG = (\/.*\/)/)?.[1];
  const ltr = src.match(/const LTR_STRONG = (\/.*\/)/)?.[1];
  expect(rtl).toBeTruthy();
  expect(ltr).toBeTruthy();
  const rtlRe = eval(rtl!) as RegExp;
  const ltrRe = eval(ltr!) as RegExp;
  // Arabic letters are RTL-strong and not LTR-strong.
  for (const ch of "الموديلعربى") {
    expect(rtlRe.test(ch)).toBe(true);
    expect(ltrRe.test(ch)).toBe(false);
  }
  // Latin letters are LTR-strong and not RTL-strong.
  for (const ch of "ModelBNPL") {
    expect(ltrRe.test(ch)).toBe(true);
    expect(rtlRe.test(ch)).toBe(false);
  }
  // Digits and punctuation are neutral -- neither, so direction falls through.
  for (const ch of "2024 -_.") {
    expect(rtlRe.test(ch)).toBe(false);
    expect(ltrRe.test(ch)).toBe(false);
  }
});
