import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type WatchHandle = { close(): void };

/**
 * Watch ~/.claude/projects two levels deep: the root (for new project dirs)
 * plus one watcher per project dir (for session files). Never recursive —
 * recursive fs.watch support varies by platform, and deeper levels are
 * subagent transcripts, which are out of scope for v1.
 *
 * `onChange` fires once per session id after a burst of writes settles for
 * `debounceMs`, coalescing the duplicate/rename+change events a single save
 * can produce. It never fires after close() — see close() below.
 */
export async function watchProjects(
  projectsDir: string,
  onChange: (sessionId: string) => void,
  debounceMs = 120
): Promise<WatchHandle> {
  const watchers: FSWatcher[] = [];
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

  const watchProject = (dir: string) => {
    try {
      const w = watch(dir, (_event, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        emit(filename.slice(0, -".jsonl".length));
      });
      // A watched project dir can be removed later (e.g. session pruned
      // elsewhere); on some platforms that surfaces as an 'error' event on
      // the FSWatcher, which is an EventEmitter — unhandled 'error' throws
      // and would crash the whole process. Swallow it, matching the
      // read-only/never-crash posture the rest of this project takes.
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // dir vanished between listing and watching — ignore
    }
  };

  let entries: string[] = [];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { close() {} }; // missing projects dir — nothing to watch
  }

  for (const name of entries) watchProject(join(projectsDir, name));

  // Root watcher: pick up project dirs created after startup.
  try {
    const root = watch(projectsDir, (_event, filename) => {
      if (!filename || filename.endsWith(".jsonl")) return;
      watchProject(join(projectsDir, filename));
    });
    root.on("error", () => {});
    watchers.push(root);
  } catch {
    // ignore
  }

  return {
    close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) {
        try {
          w.close();
        } catch {}
      }
    },
  };
}
