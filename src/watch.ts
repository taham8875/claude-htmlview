import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { SessionRoots } from "./sessions";

export type WatchHandle = { close(): void };

type WatchSource = {
  root: string;
  maxDepth: number;
  publicId(file: string): string | null;
};

const claudeSource = (root: string): WatchSource => ({
  root,
  maxDepth: 1,
  publicId(file) {
    const parts = relative(root, file).split(sep);
    return parts.length === 2 && file.endsWith(".jsonl")
      ? basename(file, ".jsonl")
      : null;
  },
});

const CODEX_FILE_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const codexSource = (root: string): WatchSource => ({
  root,
  maxDepth: 3,
  publicId(file) {
    const id = basename(file).match(CODEX_FILE_ID_RE)?.[1];
    return id ? `codex-${id}` : null;
  },
});

async function watchSources(
  sources: WatchSource[],
  onChange: (sessionId: string) => void,
  debounceMs: number
): Promise<WatchHandle> {
  const watchers: FSWatcher[] = [];
  const watched = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const emit = (sessionId: string) => {
    if (closed) return;
    clearTimeout(timers.get(sessionId));
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        if (!closed) onChange(sessionId);
      }, debounceMs)
    );
  };

  const attachTree = async (source: WatchSource, dir: string, depth: number): Promise<void> => {
    if (closed || watched.has(dir) || depth > source.maxDepth) return;
    watched.add(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      watched.delete(dir);
      return;
    }

    try {
      const handle = watch(dir, (_event, filename) => {
        if (!filename || closed) return;
        const file = join(dir, String(filename));
        if (file.endsWith(".jsonl")) {
          const id = source.publicId(file);
          if (id) emit(id);
          return;
        }
        if (depth < source.maxDepth) void attachTree(source, file, depth + 1);
      });
      handle.on("error", () => {});
      watchers.push(handle);
    } catch {
      watched.delete(dir);
      return;
    }

    if (depth >= source.maxDepth) return;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => attachTree(source, join(dir, entry.name), depth + 1))
    );
  };

  await Promise.all(sources.map((source) => attachTree(source, source.root, 0)));

  return {
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const handle of watchers) {
        try {
          handle.close();
        } catch {}
      }
      watchers.length = 0;
    },
  };
}

/** Watch the original Claude-only tree. Kept as the public compatibility seam. */
export function watchProjects(
  projectsDir: string,
  onChange: (sessionId: string) => void,
  debounceMs = 120
): Promise<WatchHandle> {
  return watchSources([claudeSource(projectsDir)], onChange, debounceMs);
}

/** Watch both provider trees and emit the same public IDs used by routes and caches. */
export function watchSessions(
  roots: SessionRoots,
  onChange: (sessionId: string) => void,
  debounceMs = 120
): Promise<WatchHandle> {
  return watchSources(
    [claudeSource(roots.claudeProjectsDir), codexSource(roots.codexSessionsDir)],
    onChange,
    debounceMs
  );
}
