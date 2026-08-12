import { normalize } from "./normalize";
import { readCacheEntry, type CacheLine } from "./searchcache";
import { listSessions } from "./sessions";

export type Hit = {
  sessionId: string;
  project: string;
  title: string;
  turn: number;
  role: "user" | "assistant";
  snippet: string;
  matchStart: number;
  matchEnd: number;
  mtimeMs: number;
};

/**
 * Normalize while recording, per output character, the index of the source
 * UTF-16 code unit it came from — so a match found in normalized space can be
 * mapped back onto the original text the reader actually sees.
 *
 * Normalizing one code unit at a time (rather than the whole string, as
 * `searchcache.ts` does) is safe because every rule in `normalize()` is
 * context-free at the code-unit level, and lone surrogate halves pass through
 * untouched with their own map entries. The one context-sensitive casing rule
 * in Unicode — Greek final sigma — is out of scope here, and would cost a
 * missed match on that line rather than a wrong offset.
 */
function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const out = normalize(text[i]!);
    for (const ch of out) {
      normalized += ch;
      map.push(i);
    }
  }
  return { normalized, map };
}

/** True if `s[i]` is the trailing half of a UTF-16 surrogate pair. */
function splitsSurrogatePair(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false;
  const before = s.charCodeAt(i - 1);
  const at = s.charCodeAt(i);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

export function makeSnippet(
  line: CacheLine,
  query: string,
  radius = 90
): Pick<Hit, "turn" | "role" | "snippet" | "matchStart" | "matchEnd"> | null {
  const q = normalize(query).trim();
  if (!q) return null;

  const { normalized, map } = normalizeWithMap(line.original);
  const at = normalized.indexOf(q);
  if (at < 0) return null;

  // Map normalized-space match bounds back into original-string indices.
  const origStart = map[at] ?? 0;
  const lastIdx = Math.min(at + q.length - 1, map.length - 1);
  const origEnd = (map[lastIdx] ?? origStart) + 1;

  let from = Math.max(0, origStart - radius);
  let to = Math.min(line.original.length, origEnd + radius);
  // Context padding is an arbitrary character count with no awareness of
  // surrogate pairs. Nudge outward rather than inward, so we never lose part
  // of the match itself -- only ever add a code unit of extra context.
  if (splitsSurrogatePair(line.original, from)) from -= 1;
  if (splitsSurrogatePair(line.original, to)) to += 1;

  const prefix = from > 0 ? "…" : "";
  const suffix = to < line.original.length ? "…" : "";
  const snippet = prefix + line.original.slice(from, to) + suffix;

  return {
    turn: line.turn,
    role: line.role,
    snippet,
    matchStart: prefix.length + (origStart - from),
    matchEnd: prefix.length + (origEnd - from),
  };
}

export async function search(query: string, projectsDir?: string): Promise<Hit[]> {
  const q = normalize(query).trim();
  if (!q) return [];

  const sessions = await listSessions(projectsDir); // already sorted newest-first
  const hits: Hit[] = [];
  for (const session of sessions) {
    for (const line of await readCacheEntry(session.id)) {
      if (!line.normalized.includes(q)) continue; // cheap reject before the expensive map
      const snippet = makeSnippet(line, query);
      if (!snippet) continue;
      hits.push({
        ...snippet,
        sessionId: session.id,
        project: session.project,
        title: session.title,
        mtimeMs: session.mtimeMs,
      });
    }
  }
  return hits; // recency order inherited from listSessions
}
