
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
