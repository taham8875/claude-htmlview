import { join, resolve, sep } from "node:path";
import { stat, realpath } from "node:fs/promises";
import {
  defaultProjectsDir,
  listSessions,
  newestSession,
  findSession,
  SESSION_ID_RE,
  type SessionRoots,
} from "./sessions";
import { search } from "./search";
import { refreshCache, buildCacheEntry } from "./searchcache";
import { watchProjects } from "./watch";
import { listArtifacts, artifactsDir } from "./artifacts";

const PUBLIC = resolve(join(import.meta.dir, "..", "public"));

// Resolved once at module load, not per-request: PUBLIC itself can be reached
// via a symlinked path in some checkouts (e.g. a symlinked repo clone), so
// comparing a per-request *resolved* target against a lexical PUBLIC would be
// comparing resolved-against-unresolved and could reject legitimate requests
// or, worse, mis-contain them. Falls back to the lexical PUBLIC if it somehow
// doesn't exist yet (e.g. a from-scratch checkout before public/ is created).
const REAL_PUBLIC = await realpath(PUBLIC).catch(() => PUBLIC);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const htmlShell = () =>
  new Response(Bun.file(join(PUBLIC, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * The client-side routes that must always render the SPA shell, regardless
 * of whether a matching static file exists. Everything else falls through to
 * "serve a real file under public/, or 404" — see the traversal test in
 * server.test.ts for why an unbounded catch-all here is a real bug: treating
 * *any* unmatched path as an app route returns 200 for it, which a client's
 * error handling cannot distinguish from a page that actually exists.
 */
function isAppRoute(path: string): boolean {
  return path === "/" || path === "/search" || path === "/artifacts" || path.startsWith("/s/");
}

/** Query-param int, clamped into [min, max]; any non-finite/missing value falls back. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Bun.serve()'s default idleTimeout. A connection that neither sends nor
 * receives data for this long is torn down -- which for an SSE stream means
 * every quiet period kills it, since the server only writes on a real change.
 */
export const BUN_IDLE_TIMEOUT_MS = 10_000;

/**
 * How often /events writes a keep-alive comment. Writing to the response
 * resets the idle timer (verified empirically: a stream pinging every 2s
 * outlives 20s, an identical silent one dies at ~10s), so this only has to
 * stay comfortably below BUN_IDLE_TIMEOUT_MS. The payload is 9 bytes.
 */
export const SSE_HEARTBEAT_MS = 4_000;

export type ServerOptions = {
  /** Explicit dual-provider roots. `projectsDir` remains the Claude-only compatibility seam. */
  sessionRoots?: SessionRoots;
  projectsDir?: string;
  port?: number;
  /** Test seam: shorten the heartbeat so a test need not wait whole seconds. */
  heartbeatMs?: number;
};

/** True for the specific error Bun.serve() throws synchronously when the requested port is taken. */
function isPortInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EADDRINUSE";
}

/**
 * Bun.serve() throws synchronously (not a rejected promise) with `err.code
 * === "EADDRINUSE"` when the requested port is taken — verified empirically.
 * Retry on the next port up, `maxAttempts` times, rather than letting a
 * second instance crash with a raw stack trace. `port: 0` (the test seam
 * meaning "any free port", already relied on by every *.test.ts fixture)
 * can't conflict, so it's tried exactly once and never bumped.
 */
function bindWithFallback(
  fetch: (req: Request) => Response | Promise<Response>,
  requestedPort: number,
  maxAttempts = 20
): ReturnType<typeof Bun.serve> {
  if (requestedPort === 0) {
    return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  }
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const port = requestedPort + i;
    try {
      return Bun.serve({ hostname: "127.0.0.1", port, fetch }); // never 0.0.0.0 — transcripts can contain file contents and secrets
    } catch (err) {
      if (!isPortInUse(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `Could not bind any port in [${requestedPort}, ${requestedPort + maxAttempts - 1}]: ${lastErr}`
  );
}

export async function createServer(opts: ServerOptions = {}) {
  const sessionInput = opts.sessionRoots ?? opts.projectsDir;
  const projectsDir = opts.sessionRoots?.claudeProjectsDir ?? opts.projectsDir ?? defaultProjectsDir();
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const clients = new Set<(sessionId: string) => void>();

  const server = bindWithFallback(async function fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/sessions") return json(await listSessions(sessionInput));

    if (path.startsWith("/api/session/")) {
      const raw = path.slice("/api/session/".length);
      let id: string;
      try {
        id = decodeURIComponent(raw);
      } catch {
        return json({ error: "bad id" }, 400);
      }
      if (!SESSION_ID_RE.test(id)) return json({ error: "not found" }, 404);

      const found = await findSession(id, sessionInput);
      if (!found) return json({ error: "not found" }, 404);
      const { meta, turns } = found;

      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const before = clampInt(url.searchParams.get("before"), turns.length, 0, turns.length);
      const start = Math.max(0, before - limit);
      return json({ meta, turns: turns.slice(start, before), hasMore: start > 0 });
    }

    if (path === "/api/search") {
      return json(await search(url.searchParams.get("q") ?? "", sessionInput));
    }

    if (path === "/api/artifacts") return json(await listArtifacts());

    if (path === "/events") {
      let send: ((sessionId: string) => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = () => {
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
      };
      const stream = new ReadableStream({
        start(controller) {
          send = (sessionId: string) =>
            controller.enqueue(`data: ${JSON.stringify({ sessionId })}\n\n`);
          clients.add(send);
          controller.enqueue(": connected\n\n");

          // Keep the stream from going quiet long enough for Bun to reclaim
          // it as idle. Without this the connection dies during any lull,
          // EventSource reconnects a couple of seconds later, and every
          // change in that gap is broadcast to nobody -- an open page silently
          // stops updating until the reader reloads by hand. A comment line
          // is inert to EventSource: it resets the idle timer and fires no
          // onmessage, so clients never see a synthetic update.
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(": ping\n\n");
            } catch {
              // Controller already closed and cleanup hasn't run yet -- stop
              // ticking rather than throwing out of a timer callback, where
              // there is no caller to catch it.
              stopHeartbeat();
            }
          }, heartbeatMs);
          // Never let a keep-alive timer be the reason the process stays up.
          heartbeat.unref?.();
          // The primary cleanup path: fires promptly when the client
          // actually closes the connection (page navigation, tab close,
          // EventSource.close()). Verified this fires within ~1ms of a
          // real disconnect (AbortController.abort() on the fetch).
          req.signal.addEventListener("abort", () => {
            stopHeartbeat();
            if (send) clients.delete(send);
            try {
              controller.close();
            } catch {}
          });
        },
        // Belt-and-suspenders: fires when the stream's reader is cancelled
        // directly. Measured this can lag well behind the abort event for
        // a reader-only cancel (no socket teardown) — see report — so it's
        // not the primary signal, but costs nothing to also handle.
        cancel() {
          stopHeartbeat();
          if (send) clients.delete(send);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (path === "/live") {
      const newest = await newestSession(sessionInput);
      return new Response(null, {
        status: 302,
        headers: { location: newest ? `/s/${newest.id}` : "/" },
      });
    }

    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);

    if (isAppRoute(path)) return htmlShell();

    // Artifact library: serves files written by the htmlview-artifact
    // skill from artifactsDir() (~/.claude/htmlview/artifacts by default,
    // overridable for tests). This is arbitrary-file-serving from a
    // user-writable directory -- the same symlink-escape shape the static
    // route below has to defend, so it gets the same three-step
    // treatment: decode before containment-checking (encoded
    // traversal survives literal-".." checks), lexically contain the
    // decoded target, then realpath()-contain the *resolved* target since
    // stat()/Bun.file() follow symlinks past the lexical check. Unlike
    // PUBLIC, artifactsDir() is resolved per-request rather than cached at
    // module load: it's overridable per-test via HTMLVIEW_ARTIFACTS_DIR
    // and may not exist yet at server startup (no artifacts written).
    if (path.startsWith("/artifact/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(path.slice("/artifact/".length));
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // Reject traversal and absolute-path escapes on the *decoded*
      // string, before any filesystem access.
      if (decoded.includes("..") || decoded.startsWith("/")) {
        return new Response("forbidden", { status: 403 });
      }

      const dir = artifactsDir();
      const target = resolve(dir, decoded);
      if (target !== dir && !target.startsWith(dir + sep)) {
        return new Response("forbidden", { status: 403 });
      }

      let realTarget: string;
      try {
        realTarget = await realpath(target);
      } catch {
        // Missing file, or a broken/dangling symlink -- 404 either way.
        return new Response("not found", { status: 404 });
      }
      const realDir = await realpath(dir).catch(() => dir);
      if (realTarget !== realDir && !realTarget.startsWith(realDir + sep)) {
        return new Response("forbidden", { status: 403 });
      }

      try {
        const st = await stat(realTarget);
        if (st.isFile()) {
          return new Response(Bun.file(realTarget), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      } catch {
        // not found, or unreadable -- fall through to 404
      }
      return new Response("not found", { status: 404 });
    }

    // Static assets from public/.
    //
    // Decode BEFORE containment-checking, not after: a check performed on
    // the still-encoded pathname (e.g. rejecting a literal "..") can be
    // bypassed by percent-encoded traversal sequences (e.g. "%2e%2e", or
    // "%2f" hiding a literal ".." behind an encoded slash) that only
    // become actual ".." / "/" once decoded. Decoding first and then
    // containing the *result* closes that gap regardless of encoding.
    //
    // Note new URL() already collapses literal ".." segments in most
    // cases (verified empirically), which is why a naive `.includes("..")`
    // guard on the raw pathname looks like it works in casual testing but
    // doesn't defend against the encoded-slash case above.
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const target = resolve(PUBLIC, decoded.replace(/^\/+/, ""));
    if (target !== PUBLIC && !target.startsWith(PUBLIC + sep)) {
      return new Response("forbidden", { status: 403 });
    }

    // The lexical check above only defends against ".." / encoded-slash
    // traversal in the *path string* — it says nothing about symlinks. A
    // symlink physically located under public/ (e.g. public/evil -> /etc)
    // passes that check because the LINK's path is contained, even though
    // stat()/Bun.file() below follow it to a target that isn't. Resolve the
    // real, symlink-free path and re-assert containment against the real
    // (also symlink-free) PUBLIC before treating it as servable.
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch {
      // Missing file, or a broken/dangling symlink — either way, 404
      // rather than letting realpath's rejection propagate as a crash.
      return new Response("not found", { status: 404 });
    }
    if (realTarget !== REAL_PUBLIC && !realTarget.startsWith(REAL_PUBLIC + sep)) {
      return new Response("forbidden", { status: 403 });
    }

    try {
      const st = await stat(realTarget);
      // no-cache means "revalidate before reuse", not "never cache" -- the
      // browser still gets a 304 for an unchanged asset. Without it these
      // responses carry no freshness information at all, so a client can go on
      // running a stale app.js after the file on disk has changed.
      if (st.isFile()) {
        return new Response(Bun.file(realTarget), {
          headers: { "cache-control": "no-cache" },
        });
      }
    } catch {
      // not found, or unreadable — fall through to 404
    }
    return new Response("not found", { status: 404 });
  }, opts.port ?? 7317);

  const rebuilding = new Set<string>(); // sessions with a rebuild in flight
  const rebuildAgain = new Set<string>(); // sessions that changed again mid-rebuild

  /**
   * Rebuild the search cache entry for one session. Fire-and-forget from the
   * watcher callback below: search() must never keep serving stale (or
   * silently empty) results for a session the server has been watching all
   * along -- see finding 1's report. findSession() parses only this one
   * file rather than the whole corpus (listSessions() would), which matters
   * because sessions in this corpus run up to ~57MB.
   *
   * Never let a rebuild crash the watcher callback or block the SSE
   * broadcast that fires alongside it -- both would turn a slow/missing
   * cache write into a broken live-update feed too.
   *
   * A single huge, actively-written session can otherwise pile up
   * concurrent rebuilds of itself: measured ~190ms to rebuild the cache
   * entry for a real 56MB transcript, and the watcher's debounce (120ms)
   * means a continuously-active session can re-fire faster than that. The
   * in-flight guard collapses any events that land *during* a rebuild into
   * one follow-up rebuild afterward, rather than running them concurrently.
   */
  async function rebuildCacheFor(sessionId: string): Promise<void> {
    if (rebuilding.has(sessionId)) {
      rebuildAgain.add(sessionId);
      return;
    }
    rebuilding.add(sessionId);
    try {
      const found = await findSession(sessionId, sessionInput);
      if (found) await buildCacheEntry(found.meta);
    } catch {
      // Source vanished mid-rebuild, or a transient read error -- the next
      // watch event retries. Never propagate: this must not crash the
      // fire-and-forget caller.
    } finally {
      rebuilding.delete(sessionId);
      if (rebuildAgain.delete(sessionId)) void rebuildCacheFor(sessionId);
    }
  }

  const watcher = await watchProjects(projectsDir, (sessionId) => {
    void rebuildCacheFor(sessionId); // never awaited -- must not delay the SSE broadcast below

    for (const send of clients) {
      try {
        send(sessionId);
      } catch {
        // A dead/slow client's enqueue() can throw (broken pipe, closed
        // controller). Catching per-client keeps one bad connection from
        // aborting the broadcast to every other connected client.
        clients.delete(send);
      }
    }
  });

  // server.stop() also tears down the watcher, so a caller only has one
  // handle to manage. Guarded with `stopped` so a second call — Bun's own
  // server.stop() is safe to call twice, verified empirically — doesn't
  // call watcher.close() redundantly (harmless either way, since close() is
  // itself idempotent-safe, but there's no reason to rely on that twice).
  let stopped = false;
  const originalStop = server.stop.bind(server);
  server.stop = ((...args: Parameters<typeof server.stop>) => {
    if (!stopped) {
      stopped = true;
      watcher.close();
    }
    return originalStop(...args);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 7317;
  const server = await createServer({ port });
  console.log(`claude-htmlview  http://127.0.0.1:${server.port}`);
  console.log(`  live view       http://127.0.0.1:${server.port}/live`);
  const rebuilt = await refreshCache();
  console.log(`  search cache    ${rebuilt} session(s) indexed`);
}
