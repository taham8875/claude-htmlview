// src/sessions.ts
import { Glob } from "bun";
import { stat } from "node:fs/promises";
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

/**
 * Claude Code encodes a cwd as a dir name by replacing "/" with "-".
 * "-home-taha-github-docmost" -> "~/github/docmost"
 */
export function decodeProject(dirName: string): string {
  const abs = dirName.replace(/-/g, "/");
  const home = homedir();
  if (abs === home) return "~";
  if (abs.startsWith(home + "/")) return "~" + abs.slice(home.length);
  return abs;
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
