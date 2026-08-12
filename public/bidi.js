// public/bidi.js
// The six bidi rules from the spec. Applied after every markdown render.
//
// Rules 4-6 (font stack, text-align: start, RTL leading) live in style.css
// because they are purely declarative. Rules 1-3 need DOM traversal.

const BLOCK_SELECTOR =
  "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt";

// Strong-directionality ranges, used to resolve direction ourselves.
// Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, and the Arabic presentation
// forms; then Latin/Greek/Cyrillic and friends for the LTR side.
const RTL_STRONG = /[֑-߿ࡠ-ࣿיִ-﷽ﹰ-ﻼ]/;
const LTR_STRONG = /[A-Za-zªµºÀ-ʸͰ-։]/;

// Elements whose text is excluded from the count. An identifier or file path
// is incidental Latin inside Arabic prose, and a technical transcript carries
// enough of it to outvote the sentence it sits in.
const CODE_SELECTOR = "code, pre, kbd, samp";

// RTL share of the strongly-directional characters at which a block flips to
// rtl. Deliberately not 0.5: Arabic prose about code carries so much Latin
// (identifiers, paths, English technical terms) that it routinely sits under
// half, while a genuinely English sentence practically never reaches 30%
// Arabic. The asymmetry is the point -- this is a tool for an Arabic reader.
const RTL_SHARE = 0.3;

/**
 * Direction by share of strongly-directional characters, not by the first one.
 * dir="auto" is first-strong by spec (HTML's directionality algorithm,
 * mirroring UBA P2/P3), which mis-resolves the commonest shape in this corpus:
 * an Arabic sentence opening with a Latin identifier. There is no declarative
 * way to ask for a ratio, so it is counted here.
 *
 * Returns null only when there is no strong character at all, leaving the
 * caller to fall back rather than forcing a direction on no evidence.
 */
export function resolveDir(text) {
  let rtl = 0;
  let ltr = 0;
  for (const ch of text) {
    if (RTL_STRONG.test(ch)) rtl += 1;
    else if (LTR_STRONG.test(ch)) ltr += 1;
  }
  if (rtl + ltr === 0) return null;
  return rtl / (rtl + ltr) > RTL_SHARE ? "rtl" : "ltr";
}

/** textContent minus any CODE_SELECTOR subtree. */
function proseText(el) {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.nodeValue;
    else if (node.nodeType === 1 && !node.matches(CODE_SELECTOR)) out += proseText(node);
  }
  return out;
}

/**
 * The direction to write on `el`: from its prose, then from its whole text
 * (which rescues a block that is *only* code, e.g. a cell holding a single
 * identifier), then "auto" when even that has nothing directional in it.
 */
function dirFor(el) {
  return resolveDir(proseText(el)) ?? resolveDir(el.textContent || "") ?? "auto";
}

/** Write an explicit dir on one block-level element. Exported so app.js can
 *  apply the same rule to the text it builds outside markdown -- user turns,
 *  titles, search snippets. */
export function setBlockDir(el) {
  el.setAttribute("dir", dirFor(el));
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
  setBlockDir(table);
}

/**
 * Rule 1: an explicit dir on every block element, computed from the share of
 *   RTL characters (see resolveDir) — deliberately not dir="auto", whose
 *   first-strong rule misreads Arabic prose that opens on an identifier.
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
    setBlockDir(root);
  }
  if (root.matches && root.matches("pre")) {
    root.setAttribute("dir", "ltr");
  }

  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    setBlockDir(el);
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
