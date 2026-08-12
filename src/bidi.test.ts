//
// There is no DOM in Bun's test environment, and jsdom would breach the
// zero-dependency constraint. So these tests assert source contracts -- that
// the rules are textually present, and no forbidden pattern appears. They
// cannot prove the Unicode Bidirectional Algorithm behaves correctly; only a
// real browser can (see public/bidi-check.html, driven manually / via
// Playwright, not part of `bun test`).
import { test, expect } from "bun:test";

test("bidi.js sets a direction on every block element type", async () => {
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
  expect(src).toContain("resolveDir");
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

// --- Direction by RTL share --------------------------------------------------
// dir="auto" is first-strong-character by spec, which mis-resolves the most
// common shape in this corpus: an Arabic sentence that opens with a Latin
// identifier ("create_card بيتبعت في كل..."). Counting replaces it, and the
// count is deliberately not a 50% majority: a genuinely English sentence
// almost never reaches 30% Arabic, while Arabic prose about code routinely
// sits below 50%. resolveDir is pure, so unlike the rest of this file these
// are real behavioural tests -- public/bidi.js is importable outside a browser
// (the window binding at the bottom is guarded).
import { resolveDir } from "../public/bidi.js";

test("an Arabic sentence opening with a Latin word resolves rtl", () => {
  expect(resolveDir("create_card بيتبعت في كل مرة من غير ما نمرر الفلاجات")).toBe("rtl");
});

test("an English sentence containing an Arabic word resolves ltr", () => {
  expect(resolveDir("The card issuer rejects it — رفض — on every AVS mismatch")).toBe("ltr");
});

test("first-strong is not consulted: only the counts decide", () => {
  // Same two words, opposite order. First-strong would give two different
  // answers here; majority gives the same one twice.
  expect(resolveDir("English كلمة عربية طويلة جدا هنا")).toBe("rtl");
  expect(resolveDir("كلمة عربية طويلة جدا هنا English")).toBe("rtl");
});

test("rtl wins from 30% share upward, not from 50%", () => {
  expect(resolveDir("abcdefghi دعوة")).toBe("rtl"); // 4/13 = 31%
  expect(resolveDir("abc دعو")).toBe("rtl"); // 3/6 = 50%, an old tie
});

test("exactly 30% is not over the line", () => {
  expect(resolveDir("abcdefg دعو")).toBe("ltr"); // 3/10 = 30% -- strictly greater wins
});

test("no strongly directional character at all falls through to null", () => {
  expect(resolveDir("2024-07-20 :: 12.5% ()")).toBeNull();
  expect(resolveDir("")).toBeNull();
});

test("bidi.js excludes code spans from the count", async () => {
  const src = await Bun.file("public/bidi.js").text();
  // Identifiers and file paths are incidental Latin inside Arabic prose;
  // counting them flips a plainly-Arabic paragraph to ltr.
  expect(src).toMatch(/CODE_SELECTOR\s*=\s*"[^"]*code[^"]*"/);
  expect(src).toContain("proseText");
});

test("bidi.js no longer leaves block direction to the browser's first-strong", async () => {
  const src = await Bun.file("public/bidi.js").text();
  // The block loop must compute a direction, not hand out a bare dir="auto".
  expect(src).not.toMatch(/querySelectorAll\(BLOCK_SELECTOR\)\)\s*\{?\s*[\s\S]{0,60}"auto"/);
  expect(src).toMatch(/querySelectorAll\(BLOCK_SELECTOR\)[\s\S]{0,80}setBlockDir/);
});
