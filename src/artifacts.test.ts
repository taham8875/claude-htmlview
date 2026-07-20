// src/artifacts.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { listArtifacts, artifactsDir } from "./artifacts";
import { createServer } from "./server";
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink, unlink } from "node:fs/promises";
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

// --- /artifact/ serving route -------------------------------------------
//
// projectsDir is a fresh empty temp dir per test (not the real
// ~/.claude/projects) so these tests exercise only the artifact route and
// never touch the user's real sessions or search cache.

async function artifactServer() {
  const projectsDir = await mkdtemp(join(tmpdir(), "htmlview-art-proj-"));
  const server = await createServer({ projectsDir, port: 0 });
  return { server, base: `http://127.0.0.1:${server.port}`, projectsDir };
}

test("serves an artifact file and lists it via /api/artifacts", async () => {
  const dir = join(artifactsDir(), "-home-taha-demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "test-artifact.html"), "<h1>hello artifact</h1>");

  const { server, base } = await artifactServer();
  try {
    const list = await (await fetch(`${base}/api/artifacts`)).json();
    expect(list.some((a: any) => a.name === "test-artifact")).toBe(true);

    const page = await fetch(`${base}/artifact/-home-taha-demo/test-artifact.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("hello artifact");
  } finally {
    server.stop();
    await rm(join(dir, "test-artifact.html"), { force: true });
  }
});

test("artifact route rejects a missing file with 404, not 500", async () => {
  const { server, base } = await artifactServer();
  try {
    const r = await fetch(`${base}/artifact/nonexistent/nope.html`);
    expect(r.status).toBe(404);
  } finally {
    server.stop();
  }
});

test("artifact route rejects literal path traversal before touching the filesystem", async () => {
  const { server, base } = await artifactServer();
  try {
    // fetch()'s own URL parser collapses "/artifact/../../../../etc/passwd"
    // down to "/etc/passwd" before the request is sent (same normalization
    // documented in server.test.ts for the static route), so this exercises
    // the same "unmatched path must not fall back to 200" property rather
    // than the literal ".." branch — the encoded-traversal tests below cover
    // the literal branch via bytes that survive to the server unnormalized.
    const r = await fetch(`${base}/artifact/../../../../etc/passwd`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    const text = await r.text();
    expect(text).not.toContain("root:");
  } finally {
    server.stop();
  }
});

test("artifact route rejects percent-encoded traversal (encoded dots)", async () => {
  const { server, base } = await artifactServer();
  try {
    const r = await fetch(`${base}/artifact/%2e%2e/%2e%2e/etc/passwd`, {});
    expect(r.status).toBeGreaterThanOrEqual(400);
    const text = await r.text();
    expect(text).not.toContain("root:");
  } finally {
    server.stop();
  }
});

test("artifact route rejects percent-encoded traversal (encoded slash) sent raw over the wire", async () => {
  const { server, base } = await artifactServer();
  try {
    // curl --path-as-is-style raw bytes: "%2f" is not collapsed by fetch()'s
    // URL parser the way a literal ".." is, so this reaches the handler
    // still containing "..%2f..%2f" — the case the decode-then-reject guard
    // exists for.
    const r = await fetch(`${base}/artifact/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    const text = await r.text();
    expect(text).not.toContain("root:");
  } finally {
    server.stop();
  }
});

test("artifact route rejects an absolute-path-shaped suffix", async () => {
  const { server, base } = await artifactServer();
  try {
    const r = await fetch(`${base}/artifact//etc/passwd`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  } finally {
    server.stop();
  }
});

test("a symlink placed inside the artifacts dir cannot be used to read a file outside it", async () => {
  // Mirrors the Task 9 exploit and its regression test in server.test.ts:
  // the lexical containment check passes trivially because the symlink's
  // own path is under artifactsDir() -- only realpath()-then-recheck closes
  // the gap, since stat()/Bun.file() follow the symlink to its real target.
  const dir = join(artifactsDir(), "-home-taha-demo-symlink");
  await mkdir(dir, { recursive: true });

  const secretDir = await mkdtemp(join(tmpdir(), "htmlview-art-secret-"));
  const secretFile = join(secretDir, "secret.txt");
  const secretContents = `TOP-SECRET-${Math.random().toString(36).slice(2)}`;
  await writeFile(secretFile, secretContents);

  const linkPath = join(dir, "escape.html");
  await symlink(secretFile, linkPath);

  const { server, base } = await artifactServer();
  try {
    const r = await fetch(`${base}/artifact/-home-taha-demo-symlink/escape.html`);
    expect(r.status).not.toBe(200);
    const text = await r.text();
    expect(text).not.toContain(secretContents);
  } finally {
    server.stop();
    await unlink(linkPath).catch(() => {});
    await rm(secretDir, { recursive: true, force: true }).catch(() => {});
  }
});
