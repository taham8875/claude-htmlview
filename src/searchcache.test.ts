// src/searchcache.test.ts
import { test, expect } from "bun:test";
import { buildCacheEntry, readCacheEntry, cacheDir, refreshCache, cachedSourceMtime } from "./searchcache";
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

// Freshness is now driven by a `#src-mtime <ms>` header recorded inside the
// cache file at build time (an exact equality check), not by comparing the
// cache file's own mtime against the source's. This sidesteps the same-tick
// problem entirely -- there is no second file's timestamp to tie against.
// We control mtimeMs directly on the SessionMeta we build from, rather than
// hoping real filesystem writes land on a particular millisecond.
test("freshness is driven by the recorded source mtime, not file timestamps", async () => {
  const tick = Date.now();
  await buildCacheEntry({ ...meta("t-tick"), mtimeMs: tick });
  expect(await cachedSourceMtime("t-tick")).toBe(tick);

  // Scramble the cache file's own OS mtime to something unrelated -- e.g. as
  // if the cache had been copied, restored, or touched. Under the old design
  // (comparing the cache file's real mtime to the source's) this would have
  // changed the freshness verdict. Under the new design it must not, because
  // freshness comes entirely from the recorded header, never from stat().
  const target = join(cacheDir(), "t-tick.txt");
  const scrambled = new Date(tick + 12_345);
  await utimes(target, scrambled, scrambled);
  expect(await cachedSourceMtime("t-tick")).toBe(tick);
});

test("pre-header cache file rebuilds exactly once, then is up to date", async () => {
  const { root, file } = await projectDir();
  const target = join(cacheDir(), "sess-refresh.txt");
  await rm(target, { force: true });
  void file;

  // Simulate a cache entry written by the old (pre-header) format.
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(target, "0\tuser\told format, no header\n");
  expect(await cachedSourceMtime("sess-refresh")).toBeNull();

  expect(await refreshCache(root)).toBe(1); // migrates: rebuilds exactly once
  expect(await refreshCache(root)).toBe(0); // now up to date
});

test("the #src-mtime header never leaks into search results", async () => {
  await buildCacheEntry(meta("t-header-leak"));
  const lines = await readCacheEntry("t-header-leak");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.original.startsWith("#src-mtime"))).toBe(false);
});
