// src/searchcache.test.ts
import { test, expect } from "bun:test";
import { buildCacheEntry, readCacheEntry, cacheDir, refreshCache } from "./searchcache";
import type { SessionMeta } from "./sessions";
import { rm, stat, mkdir, writeFile, utimes } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const meta = (id: string): SessionMeta => ({
  id, project: "~/demo", projectPath: "-home-taha-demo",
  title: "t", turnCount: 2, mtimeMs: Date.now(),
  file: "src/fixtures/basic.jsonl",
});

test("writes a cache entry and reads it back", async () => {
  await buildCacheEntry(meta("t-basic"));
  const lines = await readCacheEntry("t-basic");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.role === "user")).toBe(true);
  expect(lines.some((l) => l.role === "assistant")).toBe(true);
});

test("stores original text and exposes a normalized form", async () => {
  await buildCacheEntry(meta("t-norm"));
  const lines = await readCacheEntry("t-norm");
  const hit = lines.find((l) => l.original.includes("مثبت"));
  expect(hit).toBeDefined();
  expect(hit!.normalized).not.toContain("ً"); // no tashkeel survives
});

test("excludes tool inputs and outputs", async () => {
  await buildCacheEntry(meta("t-tools"));
  const joined = (await readCacheEntry("t-tools")).map((l) => l.original).join(" ");
  expect(joined).not.toContain("fc-list");
  expect(joined).not.toContain("Iosevka NFM");
});

test("excludes thinking blocks", async () => {
  await buildCacheEntry(meta("t-think"));
  const joined = (await readCacheEntry("t-think")).map((l) => l.original).join(" ");
  expect(joined).not.toContain("They want the font list");
});

// The obvious version of this test (grep edge.jsonl for a literal "\n\t") is
// vacuous: edge.jsonl has no actual tab/newline content, so any implementation
// -- even one that mangles escaping -- passes it. This version constructs real
// tab and newline characters *and* literal backslash-n/backslash-t sequences
// (e.g. from a user typing a regex), and checks exact round-trip equality.
test("round-trips text containing real tabs/newlines and literal backslash-n/t", async () => {
  await buildCacheEntry({ ...meta("t-esc"), file: "src/fixtures/escaping.jsonl" });
  const lines = await readCacheEntry("t-esc");
  const user = lines.find((l) => l.role === "user")!;
  const assistant = lines.find((l) => l.role === "assistant")!;
  expect(user).toBeDefined();
  expect(assistant).toBeDefined();
  expect(user.original).toBe("before\nafter\ttab-end");
  expect(assistant.original).toBe(
    "regex uses \\n and \\t for newline and tab; here col1\tcol2 too"
  );
});

test("returns empty for an absent cache entry rather than throwing", async () => {
  await rm(join(cacheDir(), "t-missing.txt"), { force: true });
  expect(await readCacheEntry("t-missing")).toEqual([]);
});

test("cache is derived state: deleting the dir is harmless", async () => {
  await buildCacheEntry(meta("t-rebuild"));
  await rm(cacheDir(), { recursive: true, force: true });
  expect(await readCacheEntry("t-rebuild")).toEqual([]);
  await buildCacheEntry(meta("t-rebuild"));
  expect((await readCacheEntry("t-rebuild")).length).toBeGreaterThan(0);
});

test("never writes outside ~/.claude/htmlview", async () => {
  await buildCacheEntry(meta("t-path"));
  expect(cacheDir()).toContain("/.claude/htmlview/");
  await stat(join(cacheDir(), "t-path.txt")); // throws if absent
});

async function projectDir() {
  const root = await mkdtemp(join(tmpdir(), "htmlview-cache-"));
  const proj = join(root, "-home-taha-github-refresh-demo");
  await mkdir(proj, { recursive: true });
  const body = await Bun.file("src/fixtures/basic.jsonl").text();
  await writeFile(join(proj, "sess-refresh.jsonl"), body);
  return { root, file: join(proj, "sess-refresh.jsonl") };
}

test("refreshCache rebuilds missing entries and skips up-to-date ones", async () => {
  const { root, file } = await projectDir();
  await rm(join(cacheDir(), "sess-refresh.txt"), { force: true });

  expect(await refreshCache(root)).toBe(1); // no cache yet -> rebuild
  expect(await refreshCache(root)).toBe(0); // source unchanged -> skip

  // Touch the source with a strictly later mtime and confirm it rebuilds.
  const future = new Date(Date.now() + 5000);
  await utimes(file, future, future);
  expect(await refreshCache(root)).toBe(1);
});

// Regression test for a real bug in the reference implementation: comparing
// source mtime to cached mtime with a strict `>` misses the case where a
// transcript is (re)written in the exact same millisecond the previous cache
// build completed -- ties read as "not newer" and the stale cache survives
// forever. `>=` is required so a tie is treated as "rebuild to be safe."
test("rebuilds when the source mtime exactly ties the cache mtime", async () => {
  const { root, file } = await projectDir();
  const target = join(cacheDir(), "sess-refresh.txt");
  await rm(target, { force: true });

  await refreshCache(root); // creates the cache entry
  const cachedAt = (await stat(target)).mtimeMs;

  // Force the source transcript's mtime to exactly equal the cache's mtime,
  // simulating same-millisecond writes rather than hoping to reproduce one.
  const tie = new Date(cachedAt);
  await utimes(file, tie, tie);

  expect(await refreshCache(root)).toBe(1);
});
