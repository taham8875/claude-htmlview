// src/sessions.ts
import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseTranscript } from "./transcript";

export type SessionMeta = {
  id: string;
  project: string;
  projectPath: string;
  title: string;
  turnCount: number;
  mtimeMs: number;
  file: string;
};

export const defaultProjectsDir = () => join(homedir(), ".claude", "projects");

/** Cache: 17 distinct project dirs, resolved once each rather than per session. */
const decodeCache = new Map<string, string>();

/**
 * Claude Code encodes a cwd as a dir name by replacing "/" with "-".
 *
 * The encoding is LOSSY: a literal hyphen in a path is indistinguishable from a
 * separator, so "-home-taha-github-controller-type" could be
 * ".../controller/type" or ".../controller-type". A naive global replace picks
 * the wrong one for ~41% of real project dirs on this machine.
 *
 * Resolution: search the filesystem, trying the LONGEST candidate segment
 * first but BACKTRACKING when the remainder cannot be fully resolved. Falls
 * back to the naive split when no complete resolution exists (deleted project).
 *
 * `exists` is injectable so tests can supply a virtual filesystem instead of
 * writing directories into the real home tree.
 */
export function resolveEncodedPath(
  dirName: string,
  exists: (p: string) => boolean = existsSync
): string {
  const tokens = dirName.replace(/^-/, "").split("-");

  /**
   * Returns a fully-resolved path from position i, or null if none exists.
   *
   * Backtracking is required, not a nicety: a purely greedy walk commits to a
   * wrong split whenever a coincidentally-named sibling exists. With a real cwd
   * of ~/github/foo/bar and an unrelated ~/github/foo-bar also on disk, greedy
   * returns ~/github/foo-bar and never reconsiders, even though the correct
   * nested path is fully present.
   */
  function walk(i: number, prefix: string): string | null {
    if (i >= tokens.length) return prefix;
    for (let j = tokens.length; j > i; j--) {
      const next = `${prefix}/${tokens.slice(i, j).join("-")}`;
      if (!exists(next)) continue;
      const resolved = walk(j, next);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  return walk(0, "") ?? "/" + tokens.join("/");
}

export function decodeProject(dirName: string): string {
  const cached = decodeCache.get(dirName);
  if (cached !== undefined) return cached;

  const abs = resolveEncodedPath(dirName);
  const home = homedir();
  const out = abs === home ? "~" : abs.startsWith(home + "/") ? "~" + abs.slice(home.length) : abs;

  decodeCache.set(dirName, out);
  return out;
}

export async function listSessions(
  projectsDir: string = defaultProjectsDir()
): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  // NON-recursive by design: "*/*.jsonl" excludes <session>/subagents/agent-*.jsonl
  const glob = new Glob("*/*.jsonl");
  let files: string[] = [];
  try {
    for await (const f of glob.scan({ cwd: projectsDir, absolute: true })) files.push(f);
  } catch {
    return []; // missing or unreadable projects dir
  }

  for (const file of files) {
    try {
      const [st, text] = await Promise.all([stat(file), Bun.file(file).text()]);
      const parsed = parseTranscript(text);
      const id = basename(file, ".jsonl");
      const dirName = basename(dirname(file));
      out.push({
        id,
        project: decodeProject(dirName),
        projectPath: dirName,
        title: parsed.title ?? parsed.turns[0]?.userText?.slice(0, 80) ?? id,
        turnCount: parsed.turns.length,
        mtimeMs: st.mtimeMs,
        file,
      });
    } catch {
      continue; // deleted mid-scan, or unreadable — drop from index, never crash
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function newestSession(
  projectsDir: string = defaultProjectsDir()
): Promise<SessionMeta | null> {
  return (await listSessions(projectsDir))[0] ?? null;
}
