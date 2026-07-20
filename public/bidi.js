// public/bidi.js
// The six bidi rules from the spec. Applied after every markdown render.
//
// Rules 4-6 (font stack, text-align: start, RTL leading) live in style.css
// because they are purely declarative. Rules 1-3 need DOM traversal.

const BLOCK_SELECTOR = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote";

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
}

if (typeof window !== "undefined") {
  window.applyBidi = applyBidi;
}
