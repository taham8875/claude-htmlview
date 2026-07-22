// public/bidi.js
// The six bidi rules from the spec. Applied after every markdown render.
//
// Rules 4-6 (font stack, text-align: start, RTL leading) live in style.css
// because they are purely declarative. Rules 1-3 need DOM traversal.

const BLOCK_SELECTOR =
  "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt";

// Strong-directionality ranges, used to resolve table direction ourselves.
// Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, and the Arabic presentation
// forms; then Latin/Greek/Cyrillic and friends for the LTR side.
const RTL_STRONG = /[֑-߿ࡠ-ࣿיִ-﷽ﹰ-ﻼ]/;
const LTR_STRONG = /[A-Za-zªµºÀ-ʸͰ-։]/;

/** First strongly-directional character wins, mirroring the dir="auto"
 *  heuristic. Returns null when the text has no strong character either way. */
function firstStrongDir(text) {
  for (const ch of text) {
    if (RTL_STRONG.test(ch)) return "rtl";
    if (LTR_STRONG.test(ch)) return "ltr";
  }
  return null;
}

/**
 * Tables need their direction computed, not delegated to dir="auto".
 *
 * Column order is decided by the direction of the <table> element -- setting
 * dir on the cells only affects text *inside* each cell. But dir="auto" on the
 * table cannot work here: the HTML directionality algorithm ignores text inside
 * descendants that carry their own dir, and we set dir="auto" on every td/th.
 * The table is therefore left with no text of its own to inspect and silently
 * falls back to LTR, laying an Arabic table's first column out on the left.
 *
 * Measured: table dir="auto" with bare cells resolves rtl; the same table with
 * dir="auto" cells resolves ltr. So we read the text ourselves and set an
 * explicit dir, which the cells' own dir attributes cannot suppress.
 */
function applyTableDir(table) {
  table.setAttribute("dir", firstStrongDir(table.textContent || "") ?? "auto");
}

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

  // The root itself may be one of the block tags (e.g. applyBidi called
  // directly on a <p>). querySelectorAll only reaches descendants, so the
  // root's own tag needs a separate check.
  if (root.matches && root.matches(BLOCK_SELECTOR)) {
    root.setAttribute("dir", "auto");
  }
  if (root.matches && root.matches("pre")) {
    root.setAttribute("dir", "ltr");
  }

  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    el.setAttribute("dir", "auto");
  }

  for (const pre of root.querySelectorAll("pre")) {
    pre.setAttribute("dir", "ltr");
  }

  // Must run after the cells above: applyTableDir reads the table's text, and
  // is deliberately immune to the cells having their own dir.
  if (root.matches && root.matches("table")) applyTableDir(root);
  for (const table of root.querySelectorAll("table")) applyTableDir(table);
}

if (typeof window !== "undefined") {
  window.applyBidi = applyBidi;
}
