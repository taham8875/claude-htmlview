// src/sessions.test.ts
import { test, expect } from "bun:test";
import { decodeProject, listSessions } from "./sessions";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("decodes an encoded project dir to a tilde path", () => {
  expect(decodeProject("-home-taha-github-docmost")).toBe("~/github/docmost");
  expect(decodeProject("-home-taha")).toBe("~");
});

test("preserves literal hyphens in real directory names", () => {
  // The encoding is lossy: "-" is both a separator and a literal character.
  // Resolution walks the filesystem, preferring the longest existing segment.
  // ~41% of real project dirs on this machine contain a literal hyphen.
  const { mkdirSync } = require("node:fs");
  const { homedir } = require("node:os");
  const probe = `${homedir()}/github/controller-type`;
  mkdirSync(probe, { recursive: true });
  expect(decodeProject("-home-taha-github-controller-type")).toBe("~/github/controller-type");
});

test("falls back to naive splitting when nothing exists on disk", () => {
  expect(decodeProject("-nonexistent-alpha-beta")).toBe("/nonexistent/alpha/beta");
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
