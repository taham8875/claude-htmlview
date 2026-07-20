// src/server.ts
import { join, resolve, sep } from "node:path";
import { stat, realpath } from "node:fs/promises";
import {
  defaultProjectsDir,
  listSessions,
  newestSession,
  findSession,
  SESSION_ID_RE,
} from "./sessions";
import { search } from "./search";
import { refreshCache } from "./searchcache";
import { watchProjects } from "./watch";
import { listArtifacts } from "./artifacts";

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
 * server.test.ts for why an unbounded catch-all here is a real bug, not just
 * a style choice: the task's own draft reference implementation treated
 * *any* unmatched path as an app route and returned 200 for it, which is
 * indistinguishable, from a client's error handling, from a page that
 * actually exists.
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

export type ServerOptions = { projectsDir?: string; port?: number };

export async function createServer(opts: ServerOptions = {}) {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const clients = new Set<(sessionId: string) => void>();

  const server = Bun.serve({
    hostname: "127.0.0.1", // never 0.0.0.0 — transcripts can contain file contents and secrets
    port: opts.port ?? 7317,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/sessions") return json(await listSessions(projectsDir));

      if (path.startsWith("/api/session/")) {
        const raw = path.slice("/api/session/".length);
        let id: string;
        try {
          id = decodeURIComponent(raw);
        } catch {
          return json({ error: "bad id" }, 400);
        }
        if (!SESSION_ID_RE.test(id)) return json({ error: "not found" }, 404);

        const found = await findSession(id, projectsDir);
        if (!found) return json({ error: "not found" }, 404);
        const { meta, turns } = found;

        const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
        const before = clampInt(url.searchParams.get("before"), turns.length, 0, turns.length);
        const start = Math.max(0, before - limit);
        return json({ meta, turns: turns.slice(start, before), hasMore: start > 0 });
      }

      if (path === "/api/search") {
        return json(await search(url.searchParams.get("q") ?? "", projectsDir));
      }

      if (path === "/api/artifacts") return json(await listArtifacts());

      if (path === "/events") {
        let send: ((sessionId: string) => void) | null = null;
        const stream = new ReadableStream({
          start(controller) {
            send = (sessionId: string) =>
              controller.enqueue(`data: ${JSON.stringify({ sessionId })}\n\n`);
            clients.add(send);
            controller.enqueue(": connected\n\n");
            // The primary cleanup path: fires promptly when the client
            // actually closes the connection (page navigation, tab close,
            // EventSource.close()). Verified this fires within ~1ms of a
            // real disconnect (AbortController.abort() on the fetch).
            req.signal.addEventListener("abort", () => {
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
        const newest = await newestSession(projectsDir);
        return new Response(null, {
          status: 302,
          headers: { location: newest ? `/s/${newest.id}` : "/" },
        });
      }

      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);

      if (isAppRoute(path)) return htmlShell();

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
        if (st.isFile()) return new Response(Bun.file(realTarget));
      } catch {
        // not found, or unreadable — fall through to 404
      }
      return new Response("not found", { status: 404 });
    },
  });

  const watcher = await watchProjects(projectsDir, (sessionId) => {
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
