// src/artifacts.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { listArtifacts, artifactsDir } from "./artifacts";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect artifactsDir() to a temp dir for the whole file. Without an
// override seam here, listArtifacts() reads from the user's real
// ~/.claude/htmlview/artifacts -- read-only, so not destructive, but it makes
// assertions non-deterministic (depends on whatever the user has on disk).
// Mirrors the HTMLVIEW_CACHE_DIR seam in searchcache.ts.
let tmpRoot: string;
const savedEnv = process.env.HTMLVIEW_ARTIFACTS_DIR;
beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "htmlview-art-"));
  process.env.HTMLVIEW_ARTIFACTS_DIR = tmpRoot;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.HTMLVIEW_ARTIFACTS_DIR;
  else process.env.HTMLVIEW_ARTIFACTS_DIR = savedEnv;
  await rm(tmpRoot, { recursive: true, force: true });
});

test("returns [] when the artifacts dir does not exist", async () => {
  expect(await listArtifacts()).toEqual([]);
});

test("artifactsDir resolves under ~/.claude/htmlview when unoverridden", () => {
  const saved = process.env.HTMLVIEW_ARTIFACTS_DIR;
  delete process.env.HTMLVIEW_ARTIFACTS_DIR;
  try {
    expect(artifactsDir()).toContain("/.claude/htmlview/");
  } finally {
    if (saved === undefined) delete process.env.HTMLVIEW_ARTIFACTS_DIR;
    else process.env.HTMLVIEW_ARTIFACTS_DIR = saved;
  }
});

test("lists an artifact with decoded project and href", async () => {
  const dir = join(artifactsDir(), "-home-taha-github-demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chart.html"), "<html></html>");

  const out = await listArtifacts();
  expect(out.length).toBe(1);
  expect(out[0]!.name).toBe("chart");
  expect(out[0]!.project).toBe("~/github/demo");
  expect(out[0]!.href).toBe("/artifact/-home-taha-github-demo/chart.html");
});

test("sorts newest first", async () => {
  const dir = join(artifactsDir(), "-home-taha-github-demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old.html"), "<html></html>");
  await writeFile(join(dir, "new.html"), "<html></html>");
  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  await utimes(join(dir, "old.html"), past, past);
  await utimes(join(dir, "new.html"), now, now);

  const out = await listArtifacts();
  const names = out.map((a) => a.name);
  expect(names.indexOf("new.html".replace(".html", ""))).toBeLessThan(
    names.indexOf("old.html".replace(".html", ""))
  );
});
