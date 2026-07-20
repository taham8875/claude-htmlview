// src/searchcache.ts
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTranscript } from "./transcript";
import { listSessions, type SessionMeta } from "./sessions";
import { normalize } from "./normalize";

export type CacheLine = {
  turn: number;
  role: "user" | "assistant";
  original: string;
  normalized: string;
};

export const cacheDir = () => join(homedir(), ".claude", "htmlview", "cache");

// Backslashes must be doubled *before* newline/tab are escaped, otherwise the
// backslash introduced by the \n/\t substitution would itself get doubled on
// a later pass. Doing it first means every backslash unescape() will ever see
// was produced by exactly one of these three replacements, so a single
// left-to-right pairwise scan inverts it unambiguously.
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
const unescape = (s: string) =>
  s.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));

/**
 * Extract only human and assistant prose. Tool inputs/outputs and thinking are
 * excluded: they are mostly file contents and would swamp search results.
 */
function extractLines(jsonl: string): string[] {
  const { turns } = parseTranscript(jsonl);
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.userText?.trim()) {
      out.push(`${turn.index}\tuser\t${escape(turn.userText)}`);
    }
    for (const b of turn.blocks) {
      if (b.kind === "text" && b.text.trim()) {
        out.push(`${turn.index}\tassistant\t${escape(b.text)}`);
      }
    }
  }
  return out;
}

export async function buildCacheEntry(session: SessionMeta): Promise<void> {
  const text = await Bun.file(session.file).text();
  await mkdir(cacheDir(), { recursive: true });
  await Bun.write(join(cacheDir(), `${session.id}.txt`), extractLines(text).join("\n"));
}

export async function readCacheEntry(sessionId: string): Promise<CacheLine[]> {
  const file = Bun.file(join(cacheDir(), `${sessionId}.txt`));
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines: CacheLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const tab1 = raw.indexOf("\t");
    const tab2 = raw.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const original = unescape(raw.slice(tab2 + 1));
    lines.push({
      turn: Number(raw.slice(0, tab1)),
      role: raw.slice(tab1 + 1, tab2) as "user" | "assistant",
      original,
      normalized: normalize(original),
    });
  }
  return lines;
}

/** Rebuild any cache entry whose source transcript is newer. Returns count rebuilt. */
export async function refreshCache(projectsDir?: string): Promise<number> {
  const sessions = await listSessions(projectsDir);
  await mkdir(cacheDir(), { recursive: true });
  let rebuilt = 0;
  for (const s of sessions) {
    const target = join(cacheDir(), `${s.id}.txt`);
    let cachedAt = 0;
    try {
      cachedAt = (await stat(target)).mtimeMs;
    } catch {
      cachedAt = 0; // absent -> rebuild
    }
    // >= rather than >: mtime resolution on some filesystems is coarse enough
    // that a transcript rewritten in the same tick as the previous cache build
    // reads as "not newer" under strict >, leaving a stale cache that never
    // heals itself. A tie is treated as "rebuild" -- an occasional redundant
    // rebuild is cheap; a silently stale cache is not.
    if (s.mtimeMs >= cachedAt) {
      try {
        await buildCacheEntry(s);
        rebuilt++;
      } catch {
        continue; // source vanished mid-build; next refresh retries
      }
    }
  }
  return rebuilt;
}
