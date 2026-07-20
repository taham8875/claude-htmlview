// src/sessions.test.ts
import { test, expect } from "bun:test";
import { decodeProject, resolveEncodedPath, listSessions } from "./sessions";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  expect(s[0].id).toBe("sess-a");
  expect(s[0].project).toBe("~/github/demo");
  expect(s[0].title).toBe("Check the font setup");
  expect(s[0].turnCount).toBe(2);
});

test("never lists subagent transcripts as sessions", async () => {
  const s = await listSessions(await fixtureDir());
  expect(s.some((x) => x.id.startsWith("agent-"))).toBe(false);
});

test("returns empty for a missing projects dir rather than throwing", async () => {
  expect(await listSessions("/nonexistent/path/xyz")).toEqual([]);
});
