import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { decodeProject } from "./sessions";

export type Artifact = {
  name: string;
  project: string;
  href: string;
  file: string;
  mtimeMs: number;
};

/**
 * Overridable via HTMLVIEW_ARTIFACTS_DIR, same reason cacheDir() is
 * overridable in searchcache.ts: tests must not depend on (or be polluted
 * by) whatever the user actually has in their artifact library.
 */
export const artifactsDir = () =>
  process.env.HTMLVIEW_ARTIFACTS_DIR ??
  join(homedir(), ".local", "share", "claude-htmlview", "artifacts");

/** Read roots in precedence order. An explicit override disables legacy fallback. */
export const artifactRoots = () =>
  process.env.HTMLVIEW_ARTIFACTS_DIR
    ? [process.env.HTMLVIEW_ARTIFACTS_DIR]
    : [artifactsDir(), join(homedir(), ".claude", "htmlview", "artifacts")];

export async function listArtifacts(roots = artifactRoots()): Promise<Artifact[]> {
  const out: Artifact[] = [];
  const files: string[] = [];
  for (const root of roots) {
    try {
      for await (const file of new Glob("*/*.html").scan({
        cwd: root,
        absolute: true,
      })) {
        files.push(file);
      }
    } catch {
      continue; // a missing or unreadable root must not hide the other libraries
    }
  }

  // Mirrors listSessions()'s convention (src/sessions.ts): per-file try/continue
  // rather than one try around the whole loop. One artifact deleted mid-scan
  // (stat() throws ENOENT) must drop that one row, not empty the whole library.
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const dirName = basename(dirname(file));
      const href = `/artifact/${dirName}/${basename(file)}`;
      const mtimeMs = (await stat(file)).mtimeMs;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({
        name: basename(file, ".html"),
        project: decodeProject(dirName),
        href,
        file,
        mtimeMs,
      });
    } catch {
      continue; // deleted mid-scan, or unreadable — drop from the list, never crash
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
