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
 * by) whatever the user actually has under ~/.claude/htmlview/artifacts.
 */
export const artifactsDir = () =>
  process.env.HTMLVIEW_ARTIFACTS_DIR ?? join(homedir(), ".claude", "htmlview", "artifacts");

export async function listArtifacts(): Promise<Artifact[]> {
  const out: Artifact[] = [];
  let files: string[] = [];
  try {
    for await (const file of new Glob("*/*.html").scan({
      cwd: artifactsDir(),
      absolute: true,
    })) {
      files.push(file);
    }
  } catch {
    return []; // no artifacts dir yet, or unreadable
  }

  // Mirrors listSessions()'s convention (src/sessions.ts): per-file try/continue
  // rather than one try around the whole loop. One artifact deleted mid-scan
  // (stat() throws ENOENT) must drop that one row, not empty the whole library.
  for (const file of files) {
    try {
      const dirName = basename(dirname(file));
      out.push({
        name: basename(file, ".html"),
        project: decodeProject(dirName),
        href: `/artifact/${dirName}/${basename(file)}`,
        file,
        mtimeMs: (await stat(file)).mtimeMs,
      });
    } catch {
      continue; // deleted mid-scan, or unreadable — drop from the list, never crash
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
