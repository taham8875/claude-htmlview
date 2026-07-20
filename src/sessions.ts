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
 * Resolution: walk the filesystem greedily, preferring the LONGEST candidate
 * segment that actually exists on disk. Falls back to the naive split for path
 * components that no longer exist (deleted projects).
 */
function resolveEncodedPath(dirName: string): string {
  const tokens = dirName.replace(/^-/, "").split("-");
  let path = "";
  let i = 0;
  while (i < tokens.length) {
    let matched = "";
    let matchedEnd = i;
    // Prefer the longest joined candidate that exists as a real directory.
    for (let j = tokens.length; j > i; j--) {
      const candidate = tokens.slice(i, j).join("-");
      if (existsSync(`${path}/${candidate}`)) {
        matched = candidate;
        matchedEnd = j;
        break;
      }
    }
    if (!matched) {
      // Nothing on disk matches — fall back to one token per segment.
      matched = tokens[i];
      matchedEnd = i + 1;
    }
    path += `/${matched}`;
    i = matchedEnd;
  }
  return path;
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
