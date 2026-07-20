// src/artifacts.ts
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
  try {
    for await (const file of new Glob("*/*.html").scan({
      cwd: artifactsDir(),
      absolute: true,
    })) {
      const dirName = basename(dirname(file));
      out.push({
        name: basename(file, ".html"),
        project: decodeProject(dirName),
        href: `/artifact/${dirName}/${basename(file)}`,
        file,
        mtimeMs: (await stat(file)).mtimeMs,
      });
    }
  } catch {
    return []; // no artifacts dir yet, or unreadable
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
