import { test, expect, beforeAll, afterAll } from "bun:test";
import { buildCacheEntry, readCacheEntry, cacheDir, refreshCache, cachedSourceMtime } from "./searchcache";
import type { SessionMeta } from "./sessions";
import { rm, stat, mkdir, writeFile, utimes, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the cache to a temp dir for the whole file. Without this, the test
// below asserting the derived-state property (`rm(cacheDir(), {recursive:true})`)
// deletes the user's real ~/.claude/htmlview/cache as a side effect of `bun test`.
let tmpCache: string;
const savedEnv = process.env.HTMLVIEW_CACHE_DIR;
beforeAll(async () => {
  tmpCache = await mkdtemp(join(tmpdir(), "htmlview-cache-"));
  process.env.HTMLVIEW_CACHE_DIR = tmpCache;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.HTMLVIEW_CACHE_DIR;
  else process.env.HTMLVIEW_CACHE_DIR = savedEnv;
  await rm(tmpCache, { recursive: true, force: true });
});

const meta = (id: string): SessionMeta => ({
  id, provider: "claude", project: "~/demo", projectPath: "-home-taha-demo",
  title: "t", turnCount: 2, activityMs: Date.now(), mtimeMs: Date.now(),
  file: "src/fixtures/basic.jsonl",
});

test("indexes Codex prose under its provider-qualified cache ID", async () => {
  const id = "codex-019a1111-2222-7333-8444-555566667777";
  await buildCacheEntry({
    ...meta(id),
    provider: "codex",
    file: "src/fixtures/codex-basic.jsonl",
  });

  const lines = await readCacheEntry(id);
  expect(lines.some((line) => line.original === "Check the Codex transcript")).toBe(true);
  expect(lines.some((line) => line.original === "The transcript is valid.")).toBe(true);
  expect(await Bun.file(join(cacheDir(), `${id}.txt`)).exists()).toBe(true);
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

test("cacheDir resolves under ~/.claude/htmlview when unoverridden", () => {
  // Pure string check -- deliberately does not clear HTMLVIEW_CACHE_DIR and
  // call buildCacheEntry(), which would write to the real cache. Confirms the
  // path formula itself, independent of the test-time override in place above.
  const saved = process.env.HTMLVIEW_CACHE_DIR;
  delete process.env.HTMLVIEW_CACHE_DIR;
  try {
    expect(cacheDir()).toContain("/.claude/htmlview/");
  } finally {
    if (saved === undefined) delete process.env.HTMLVIEW_CACHE_DIR;
    else process.env.HTMLVIEW_CACHE_DIR = saved;
  }
});

test("buildCacheEntry writes a file that can be stat'd at cacheDir()", async () => {
  await buildCacheEntry(meta("t-path"));
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
  try {
    await rm(join(cacheDir(), "sess-refresh.txt"), { force: true });

    expect(await refreshCache(root)).toBe(1); // no cache yet -> rebuild
    expect(await refreshCache(root)).toBe(0); // source unchanged -> skip

    // Touch the source with a strictly later mtime and confirm it rebuilds.
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    expect(await refreshCache(root)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  try {
    const target = join(cacheDir(), "sess-refresh.txt");
    await rm(target, { force: true });
    void file;

    // Simulate a cache entry written by the old (pre-header) format.
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(target, "0\tuser\told format, no header\n");
    expect(await cachedSourceMtime("sess-refresh")).toBeNull();

    expect(await refreshCache(root)).toBe(1); // migrates: rebuilds exactly once
    expect(await refreshCache(root)).toBe(0); // now up to date
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the #src-mtime header never leaks into search results", async () => {
  await buildCacheEntry(meta("t-header-leak"));
  const lines = await readCacheEntry("t-header-leak");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.original.startsWith("#src-mtime"))).toBe(false);
});
