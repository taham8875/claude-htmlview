import { test, expect } from "bun:test";
import { decodeProject, resolveEncodedPath, listSessions, findSession } from "./sessions";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("decodes an encoded project dir to a tilde path", () => {
  expect(decodeProject("-home-taha-github-docmost")).toBe("~/github/docmost");
  expect(decodeProject("-home-taha")).toBe("~");
});

// A virtual filesystem, so these tests never touch the real home tree.
const fakeFs = (paths: string[]) => (p: string) => paths.includes(p);

test("preserves a literal hyphen in a directory name", () => {
  // The encoding is lossy: "-" is both a separator and a literal character.
  const fs = fakeFs(["/home", "/home/taha", "/home/taha/github", "/home/taha/github/controller-type"]);
  expect(resolveEncodedPath("-home-taha-github-controller-type", fs))
    .toBe("/home/taha/github/controller-type");
});

test("backtracks when a longer sibling would strand the remainder", () => {
  // Both foo-bar and foo/bar exist. Longest-first tries foo-bar, which leaves
  // "bar" unresolvable, so it must backtrack to foo/bar. A greedy resolver
  // without backtracking returns /a/foo-bar here and drops a path segment.
  const fs = fakeFs(["/a", "/a/foo-bar", "/a/foo", "/a/foo/bar"]);
  expect(resolveEncodedPath("-a-foo-bar", fs)).toBe("/a/foo-bar");
  const nested = fakeFs(["/a", "/a/foo-bar", "/a/foo", "/a/foo/bar", "/a/foo/bar/baz"]);
  expect(resolveEncodedPath("-a-foo-bar-baz", nested)).toBe("/a/foo/bar/baz");
});

test("falls back to naive splitting when nothing exists on disk", () => {
  expect(resolveEncodedPath("-nonexistent-alpha-beta", fakeFs([])))
    .toBe("/nonexistent/alpha/beta");
});

test("does not blow up exponentially on a pathological input", () => {
  // Adversarial filesystem: every multi-token grouping "exists" except any
  // touching the final token, so no complete resolution is ever found and the
  // search must explore maximally. Unmemoized this took 10.6s at 24 tokens.
  const n = 24;
  const name = "-" + Array.from({ length: n }, (_, i) => `t${i}`).join("-");
  const last = `t${n - 1}`;
  const exists = (p: string) => !p.endsWith(`-${last}`) && !p.endsWith(`/${last}`);
  const t0 = performance.now();
  const out = resolveEncodedPath(name, exists);
  const ms = performance.now() - t0;
  // Budget exhausted -> naive split, which is the correct degradation here.
  expect(out).toBe("/" + Array.from({ length: n }, (_, i) => `t${i}`).join("/"));
  expect(ms).toBeLessThan(1000);
});

async function fixtureDir() {
  const root = await mkdtemp(join(tmpdir(), "htmlview-"));
  const proj = join(root, "-home-taha-github-demo");
  await mkdir(proj, { recursive: true });
  const body = await Bun.file("src/fixtures/basic.jsonl").text();
  await writeFile(join(proj, "sess-a.jsonl"), body);
  // A subagent transcript, which must NOT be listed as a session.
  const sub = join(proj, "sess-a", "subagents");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "agent-x.jsonl"), body);
  return root;
}

test("lists sessions with decoded project and derived title", async () => {
  const s = await listSessions(await fixtureDir());
  expect(s.length).toBe(1);
  expect(s[0]!.id).toBe("sess-a");
  expect(s[0]!.project).toBe("~/github/demo");
  expect(s[0]!.title).toBe("Check the font setup");
  expect(s[0]!.turnCount).toBe(2);
});

test("never lists subagent transcripts as sessions", async () => {
  const s = await listSessions(await fixtureDir());
  expect(s.some((x) => x.id.startsWith("agent-"))).toBe(false);
});

test("returns empty for a missing projects dir rather than throwing", async () => {
  expect(await listSessions("/nonexistent/path/xyz")).toEqual([]);
});

/** Two sessions whose in-file activity and file mtime disagree. */
async function skewedDir() {
  const root = await mkdtemp(join(tmpdir(), "htmlview-"));
  const proj = join(root, "-home-taha-github-demo");
  await mkdir(proj, { recursive: true });
  const line = (ts: string) =>
    `{"type":"user","uuid":"u1","timestamp":"${ts}","message":{"role":"user","content":"hi"}}`;
  await writeFile(join(proj, "stale.jsonl"), line("2026-07-20T10:00:00.000Z"));
  await writeFile(join(proj, "fresh.jsonl"), line("2026-07-25T10:00:00.000Z"));
  await utimes(join(proj, "stale.jsonl"), new Date(), new Date());
  await utimes(join(proj, "fresh.jsonl"), new Date(1), new Date(1));
  return { root, proj };
}

test("sorts by the newest timestamp inside the transcript, not file mtime", async () => {
  // Verified on this machine: every `claude` process still holding a session
  // open rewrites that session's .jsonl periodically without appending a turn,
  // which bumps mtime and floats days-old conversations to the top of the list.
  const { root } = await skewedDir();
  expect((await listSessions(root)).map((s) => s.id)).toEqual(["fresh", "stale"]);
});

test("keeps mtimeMs alongside activityMs, since the search cache keys on it", async () => {
  const { root } = await skewedDir();
  const stale = (await listSessions(root)).find((s) => s.id === "stale")!;
  expect(stale.activityMs).toBe(Date.parse("2026-07-20T10:00:00.000Z"));
  expect(stale.mtimeMs).toBeGreaterThan(stale.activityMs);
});

test("falls back to file mtime when the transcript carries no timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlview-"));
  const proj = join(root, "-home-taha-github-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "sess-b.jsonl"), `{"type":"ai-title","aiTitle":"no times here"}`);
  await utimes(join(proj, "sess-b.jsonl"), new Date(12_345_000), new Date(12_345_000));
  const [s] = await listSessions(root);
  expect(s!.activityMs).toBe(12_345_000);
});

// findSession looks up one session without parsing the rest of the corpus
// (listSessions parses every transcript to build its list -- too slow for a
// route hit on every navigation, see server.ts). It must return the same
// data listSessions would for that id, without touching sibling sessions.

test("findSession returns the same meta and turns listSessions would, for one id", async () => {
  const root = await fixtureDir();
  const found = await findSession("sess-a", root);
  expect(found).not.toBeNull();
  expect(found!.meta.id).toBe("sess-a");
  expect(found!.meta.project).toBe("~/github/demo");
  expect(found!.meta.title).toBe("Check the font setup");
  expect(found!.turns.length).toBe(2);
});

test("findSession returns null for an unknown id", async () => {
  const root = await fixtureDir();
  expect(await findSession("does-not-exist", root)).toBeNull();
});

test("findSession returns null rather than throwing for a traversal-shaped id", async () => {
  const root = await fixtureDir();
  // Must not be interpreted as a glob/path segment -- see the strict charset
  // check in findSession. "/" alone would, if unvalidated, turn "*/<id>.jsonl"
  // into a pattern that can walk outside projectsDir.
  for (const id of ["../../../etc/passwd", "..", "a/b", "*", ""]) {
    expect(await findSession(id, root)).toBeNull();
  }
});

test("findSession never lists subagent transcripts as sessions", async () => {
  const root = await fixtureDir();
  expect(await findSession("agent-x", root)).toBeNull();
});
