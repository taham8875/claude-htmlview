import { test, expect } from "bun:test";
import { normalize } from "./normalize";

test("strips tashkeel diacritics", () => {
  expect(normalize("مُشْكِلَة")).toBe(normalize("مشكلة"));
});

test("unifies all alef forms to bare alef", () => {
  for (const alef of ["أ", "إ", "آ", "ٱ"]) {
    expect(normalize(alef)).toBe("ا");
  }
});

test("unifies taa marbuta to haa", () => {
  expect(normalize("مشكلة")).toBe("مشكله");
});

test("unifies alef maqsura to yaa", () => {
  expect(normalize("على")).toBe("علي");
});

test("strips tatweel", () => {
  expect(normalize("مـــشكله")).toBe("مشكله");
});

test("folds Arabic-Indic digits to ASCII", () => {
  expect(normalize("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  expect(normalize("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
});

test("lowercases Latin", () => {
  expect(normalize("HeLLo")).toBe("hello");
});

test("the motivating case: مشكله matches مُشْكِلَة", () => {
  expect(normalize("مُشْكِلَة")).toBe(normalize("مشكله"));
});

test("is idempotent", () => {
  const input = "مُشْكِلَة HeLLo ٠١٢ على";
  expect(normalize(normalize(input))).toBe(normalize(input));
});

test("preserves length-independent content of mixed text", () => {
  expect(normalize("Fix مشكلة in docmost")).toBe("fix مشكله in docmost");
});
