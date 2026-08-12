import { mkdir } from "node:fs/promises";
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

/**
 * Cache location. Overridable via HTMLVIEW_CACHE_DIR.
 *
 * The override exists because tests must never touch the real cache: a test
 * asserting the derived-state property calls `rm(cacheDir(), {recursive:true})`,
 * and without a seam that deletes the user's actual cache as a side effect of
 * running `bun test`. Tests point this at a temp dir.
 */
export const cacheDir = () =>
  process.env.HTMLVIEW_CACHE_DIR ?? join(homedir(), ".claude", "htmlview", "cache");

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

/** First line of every cache file: the source mtime this entry was built from. */
const HEADER = "#src-mtime ";

export async function buildCacheEntry(session: SessionMeta): Promise<void> {
  const text = await Bun.file(session.file).text();
  await mkdir(cacheDir(), { recursive: true });
  // Record the source mtime we built from, rather than relying on the cache
  // file's own write-completion mtime as a proxy. Comparing two independently
  // timestamped files is ambiguous: they can tie within the same millisecond,
  // and the cache file's mtime also drifts if it's copied, restored, or
  // touched. Recording it is exact and immune to that drift.
  const body = [HEADER + session.mtimeMs, ...extractLines(text)].join("\n");
  await Bun.write(join(cacheDir(), `${session.id}.txt`), body);
}

/** The source mtime a cache entry was built from, or null if absent/unreadable. */
export async function cachedSourceMtime(sessionId: string): Promise<number | null> {
  const file = Bun.file(join(cacheDir(), `${sessionId}.txt`));
  if (!(await file.exists())) return null;
  const firstLine = (await file.text()).split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith(HEADER)) return null; // pre-header entry — rebuild
  const value = Number(firstLine.slice(HEADER.length));
  return Number.isFinite(value) ? value : null;
}

export async function readCacheEntry(sessionId: string): Promise<CacheLine[]> {
  const file = Bun.file(join(cacheDir(), `${sessionId}.txt`));
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines: CacheLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    if (raw.startsWith(HEADER)) continue; // metadata, not a searchable line
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
    // Exact comparison against the mtime the entry was actually built from.
    // No tie ambiguity, because we are not comparing two independently
    // timestamped files -- the threshold is recorded data, not a stat() call.
    const builtFrom = await cachedSourceMtime(s.id);
    if (builtFrom !== s.mtimeMs) {
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
