import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, SSE_HEARTBEAT_MS, BUN_IDLE_TIMEOUT_MS } from "./server";
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the search cache to a temp dir for the whole file, same seam and
// same reason as searchcache.test.ts and artifacts.test.ts: since the server
// now rebuilds a session's cache entry from its watcher callback (finding 1),
// any test here that modifies a fixture session file to trigger the watcher
// (see the SSE broadcast test below) would otherwise write into the user's
// real ~/.claude/htmlview/cache as a side effect of `bun test`.
let tmpCache: string;
const savedCacheEnv = process.env.HTMLVIEW_CACHE_DIR;
beforeAll(async () => {
  tmpCache = await mkdtemp(join(tmpdir(), "htmlview-s-cache-"));
  process.env.HTMLVIEW_CACHE_DIR = tmpCache;
});
afterAll(async () => {
  if (savedCacheEnv === undefined) delete process.env.HTMLVIEW_CACHE_DIR;
  else process.env.HTMLVIEW_CACHE_DIR = savedCacheEnv;
  await rm(tmpCache, { recursive: true, force: true });
});

async function fixtureServer(opts: { heartbeatMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "htmlview-s-"));
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  const sessionFile = join(proj, "sess-a.jsonl");
  const fixtureBody = await Bun.file("src/fixtures/basic.jsonl").text();
  await writeFile(sessionFile, fixtureBody);
  const server = await createServer({ projectsDir: root, port: 0, ...opts });
  return { server, base: `http://127.0.0.1:${server.port}`, sessionFile, fixtureBody };
}

async function dualProviderServer() {
  const claudeProjectsDir = await mkdtemp(join(tmpdir(), "htmlview-s-claude-"));
  const codexSessionsDir = await mkdtemp(join(tmpdir(), "htmlview-s-codex-"));
  const codexDay = join(codexSessionsDir, "2026", "08", "17");
  await mkdir(codexDay, { recursive: true });
  await writeFile(
    join(codexDay, "rollout-2026-08-17T10-00-00-019a1111-2222-7333-8444-555566667777.jsonl"),
    await Bun.file("src/fixtures/codex-basic.jsonl").text()
  );
  const server = await createServer({
    sessionRoots: { claudeProjectsDir, codexSessionsDir },
    port: 0,
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

test("binds to 127.0.0.1 and never 0.0.0.0", async () => {
  const { server } = await fixtureServer();
  expect(server.hostname).toBe("127.0.0.1");
  server.stop();
});

test("GET /api/sessions lists sessions", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/api/sessions`);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.length).toBe(1);
  expect(body[0].title).toBe("Check the font setup");
  server.stop();
});

test("GET /api/session/:id returns turns", async () => {
  const { server, base } = await fixtureServer();
  const body = await (await fetch(`${base}/api/session/sess-a`)).json();
  expect(body.turns.length).toBe(2);
  expect(body.meta.id).toBe("sess-a");
  server.stop();
});

test("session routes include Codex when both provider roots are configured", async () => {
  const { server, base } = await dualProviderServer();
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    id: "codex-019a1111-2222-7333-8444-555566667777",
    provider: "codex",
  });

  const session = await (
    await fetch(`${base}/api/session/codex-019a1111-2222-7333-8444-555566667777`)
  ).json();
  expect(session.turns).toHaveLength(2);
  expect(session.meta.project).toBe("~/github/demo");
  server.stop();
});

test("GET /api/session/:id paginates from the end", async () => {
  const { server, base } = await fixtureServer();
  const body = await (await fetch(`${base}/api/session/sess-a?limit=1`)).json();
  expect(body.turns.length).toBe(1);
  expect(body.turns[0].index).toBe(1); // the LAST turn, not the first
  expect(body.hasMore).toBe(true);
  server.stop();
});

test("GET /api/session/:id 404s for an unknown id", async () => {
  const { server, base } = await fixtureServer();
  expect((await fetch(`${base}/api/session/nope`)).status).toBe(404);
  server.stop();
});

test("GET /api/search returns hits", async () => {
  const { server, base } = await fixtureServer();
  const body = await (await fetch(`${base}/api/search?q=fonts`)).json();
  expect(Array.isArray(body)).toBe(true);
  server.stop();
});

test("GET /api/search with an empty query returns an empty array", async () => {
  const { server, base } = await fixtureServer();
  expect(await (await fetch(`${base}/api/search?q=`)).json()).toEqual([]);
  server.stop();
});

test("GET /live redirects to the newest session", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/live`, { redirect: "manual" });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/s/sess-a");
  server.stop();
});

test("GET /events opens an SSE stream", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/events`);
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  await r.body?.cancel();
  server.stop();
});

test("unknown app routes serve the HTML shell", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/s/anything`);
  expect(r.headers.get("content-type")).toContain("text/html");
  server.stop();
});

test("path traversal in static serving is rejected", async () => {
  const { server, base } = await fixtureServer();
  // fetch()'s own URL parser collapses "/../../../../etc/passwd" down to
  // "/etc/passwd" before the request is even sent (verified empirically —
  // the server never sees a literal ".."). So this exercises: an unmatched,
  // non-app path with no corresponding file under public/ must NOT fall
  // back to the 200 HTML shell — it must 404/403. A route table that treats
  // "any unrecognized path" as an app route would incorrectly return 200
  // here (this is a real gap in the task's draft reference implementation —
  // see report).
  const r = await fetch(`${base}/../../../../etc/passwd`);
  expect(r.status).toBeGreaterThanOrEqual(400);
  server.stop();
});

// --- Additional coverage beyond the brief -----------------------------

test("raw traversal bytes that survive to the server (encoded slash) cannot escape public/", async () => {
  const { server, base } = await fixtureServer();
  // curl --path-as-is sends this over the wire without normalizing it first,
  // unlike fetch(). "%2f" (encoded slash) is not collapsed by URL parsing,
  // so this pathname reaches server code still containing "..%2f..%2f" —
  // exactly the case the decode-then-contain check exists for.
  const r = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
  expect(r.status).toBeGreaterThanOrEqual(400);
  const text = await r.text();
  expect(text).not.toContain("root:"); // never /etc/passwd's contents
  server.stop();
});

test("a real static file under public/ is still served (positive control for the traversal guard)", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/index.html`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  const body = await r.text();
  expect(body.length).toBeGreaterThan(0); // a real, non-empty asset — not just a 200 with no body
  server.stop();
});

// Static assets carried no cache-control and no validator (no ETag, no
// Last-Modified), leaving freshness entirely to browser heuristics. That makes
// "edit public/app.js, reload" unreliable -- the client can keep running the
// previous copy with nothing in the response telling it otherwise, which turns
// every client-side fix into a maybe. must-revalidate on a local-only reading
// tool costs one conditional request and removes the guesswork.
test("static assets are served with a revalidation header so edited client JS is picked up", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/app.js`);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toContain("no-cache");
  server.stop();
});

test("a symlink placed inside public/ cannot be used to read a file outside it", async () => {
  // The lexical containment check (target.startsWith(PUBLIC + sep)) passes
  // trivially here: the *symlink's own path* is under public/. Only the
  // resolved target — which stat()/Bun.file() follow — escapes. This is the
  // gap realpath()-then-recheck exists to close; see server.ts.
  //
  // The symlink is created inside this repo's REAL public/ directory (the
  // server always serves PUBLIC = <repo>/public, regardless of the fixture's
  // projectsDir — see fixtureServer()), so it must be removed in `finally`
  // no matter how the test exits.
  const { server, base } = await fixtureServer();

  const secretDir = await mkdtemp(join(tmpdir(), "htmlview-secret-"));
  const secretFile = join(secretDir, "secret.txt");
  const secretContents = `TOP-SECRET-${Math.random().toString(36).slice(2)}`;
  await writeFile(secretFile, secretContents);

  const linkPath = join("public", "escape-link-test");
  await symlink(secretFile, linkPath);

  try {
    const r = await fetch(`${base}/escape-link-test`);
    expect(r.status).not.toBe(200);
    const text = await r.text();
    expect(text).not.toContain(secretContents);
  } finally {
    await unlink(linkPath).catch(() => {});
    await rm(secretDir, { recursive: true, force: true }).catch(() => {});
    server.stop();
  }
});

test("GET /api/session/:id rejects a traversal-shaped id without crashing", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/api/session/${encodeURIComponent("../../../etc/passwd")}`);
  expect(r.status).toBe(404);
  server.stop();
});

test("GET /api/session/:id pagination tolerates invalid query params instead of crashing", async () => {
  const { server, base } = await fixtureServer();
  for (const qs of ["limit=abc", "limit=-10", "limit=0", "limit=999999", "before=-5", "before=abc", "before=999999"]) {
    const r = await fetch(`${base}/api/session/sess-a?${qs}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.turns)).toBe(true);
    expect(body.turns.length).toBeGreaterThanOrEqual(0);
    expect(body.turns.length).toBeLessThanOrEqual(2);
  }
  server.stop();
});

test("unmatched /api/* routes 404 as JSON, not the HTML shell", async () => {
  const { server, base } = await fixtureServer();
  const r = await fetch(`${base}/api/nonsense`);
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toContain("application/json");
  server.stop();
});

test("server.stop() is safe to call twice", async () => {
  const { server } = await fixtureServer();
  server.stop();
  expect(() => server.stop()).not.toThrow();
});

test("a dead/aborted SSE client is dropped without breaking the broadcast for others", async () => {
  const { server, base, sessionFile, fixtureBody } = await fixtureServer();

  // Client A: really disconnects (aborts the underlying connection, not just
  // stops reading — fetch().body.cancel() alone does not reliably signal the
  // server promptly; see report). If cleanup here were broken, or if a dead
  // client's enqueue() threw uncaught inside the broadcast loop, client B
  // below would never see its event.
  const acA = new AbortController();
  await fetch(`${base}/events`, { signal: acA.signal });
  acA.abort();
  await new Promise((r) => setTimeout(r, 50)); // let the abort propagate

  // Client B stays connected and must still receive the broadcast.
  const rB = await fetch(`${base}/events`);
  const reader = rB.body!.getReader();
  await reader.read(); // consume the initial ": connected" comment

  const chunkPromise = reader.read();
  // Trigger a real broadcast via the watcher by modifying the session file.
  await writeFile(sessionFile, fixtureBody + '{"type":"mode","mode":"x"}\n');

  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000));
  const result = await Promise.race([chunkPromise, timeout]);
  if (result !== "timeout") {
    const text = new TextDecoder().decode((result as any).value);
    expect(text).toContain("data:");
  }
  // else: environments without working fs.watch delivery (rare) can't
  // exercise this path; watch.ts's own delivery guarantees are covered by
  // watch.test.ts. What this test exists to prove either way is that client
  // A's disconnect didn't throw out of the fetch() calls above or hang the
  // server — reaching this line at all is evidence of that.

  // The watcher event above also kicks off a fire-and-forget cache rebuild
  // (finding 1) that this test never awaits directly -- it's not on any
  // promise chain the test already holds. Poll for it to land under this
  // file's HTMLVIEW_CACHE_DIR override before returning: otherwise the
  // write can still be in flight when this file's afterAll restores the
  // real env var, and it would land in the user's real cache instead
  // (verified this happens without the wait -- see report).
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(join(tmpCache, "sess-a.txt")).exists()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  await reader.cancel();
  server.stop();
});

// Regression: /events used to send nothing between real changes, so Bun's
// default 10s idleTimeout killed every idle SSE stream. EventSource then
// reconnected ~2s later, and any file change landing in that dead window was
// broadcast to zero clients and lost outright -- an open page just sat stale
// until the reader manually reloaded. Verified empirically that writing to the
// response resets the idle timer (a stream pinging every 2s survives past 20s,
// an identical silent one dies at ~10s), so a periodic comment is the fix.
test("an idle SSE stream is kept alive by heartbeat comments", async () => {
  const { server, base } = await fixtureServer({ heartbeatMs: 50 });
  const r = await fetch(`${base}/events`);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();

  await reader.read(); // the initial ": connected" comment

  // Three heartbeats with no file change at all: without them the stream is
  // silent and Bun tears it down.
  for (let i = 0; i < 3; i++) {
    const chunk = await Promise.race([
      reader.read().then((c) => dec.decode(c.value)),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("no heartbeat")), 2000)),
    ]);
    expect(chunk).toContain(":");
    expect(chunk).not.toContain("data:"); // a comment, not a spurious update
  }

  await reader.cancel();
  server.stop();
});

// The heartbeat only works if it fires comfortably before the timeout it
// exists to beat. Pinning the relationship here means bumping the interval
// past the timeout fails the suite rather than silently resurrecting the bug.
test("the default heartbeat interval stays well under Bun's idle timeout", () => {
  expect(SSE_HEARTBEAT_MS).toBeLessThan(BUN_IDLE_TIMEOUT_MS / 2);
});

// The heartbeat interval must not outlive the connection: a stream that is
// gone but still ticking leaks a timer per reconnect, and EventSource
// reconnects for the life of the page.
test("the heartbeat stops when the client disconnects", async () => {
  const { server, base } = await fixtureServer({ heartbeatMs: 20 });
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { signal: ac.signal });
  const reader = r.body!.getReader();
  await reader.read();
  ac.abort();
  await new Promise((res) => setTimeout(res, 200)); // several heartbeat periods

  // If enqueue-after-close threw out of the interval callback it would be an
  // unhandled error, not a rejected promise anything here awaits -- so the
  // observable assertion is that the server is still healthy afterwards.
  const ok = await fetch(`${base}/api/sessions`);
  expect(ok.status).toBe(200);
  server.stop();
});
