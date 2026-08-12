
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string; input: unknown; result: string | null }
  | { kind: "image" }
  | { kind: "unknown"; entryType: string };

export type Turn = {
  index: number;
  userText: string | null;
  blocks: Block[];
  timestamp: string | null;
};

/**
 * `lastTimestamp` is the newest timestamp carried by *any* entry, including the
 * system and metadata lines that never become turns. It is the session's real
 * last-activity time; the file's mtime is not, because a live `claude` process
 * rewrites its own transcript periodically without appending anything.
 */
export type Parsed = { title: string | null; turns: Turn[]; lastTimestamp: string | null };

/** Entry types we consume. Anything else is either ignored or flagged unknown. */
const CONSUMED = new Set(["user", "assistant", "ai-title"]);
/** Entry types known to exist and deliberately ignored (verified against real data). */
const IGNORED = new Set([
  "last-prompt", "mode", "permission-mode", "system", "file-history-snapshot",
  "attachment", "agent-name", "queue-operation", "file-history-delta", "frame-link",
]);
/** Harness-injected wrappers: present in string content, never typed by the human. */
const INJECTED = ["<task-notification>", "<system-reminder>", "<local-command-stdout>"];

/** Flatten tool_result content, which is a string on ~84% of entries and an array otherwise. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A one-line label for a collapsed tool call: description if present, else first string arg. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (typeof o.description === "string") return o.description;
  for (const v of Object.values(o)) {
    if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + "…" : v;
  }
  return "";
}

/** True if this user entry is a real human message rather than a harness injection. */
function isHumanMessage(entry: any): boolean {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") {
    return !INJECTED.some((marker) => content.includes(marker));
  }
  if (!Array.isArray(content)) return false;
  // A block array is a human message only if it has no tool_result blocks.
  return !content.some((b: any) => b?.type === "tool_result");
}

/** Human-visible text of a user message, excluding image payloads. */
function userText(entry: any): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("\n");
}

export function parseTranscript(jsonl: string): Parsed {
  let title: string | null = null;
  let lastTimestamp: string | null = null;
  const turns: Turn[] = [];
  const pendingTools = new Map<string, { kind: "tool" } & Record<string, any>>();

  let current: Turn | null = null;
  const startTurn = (text: string | null, ts: string | null): Turn => {
    current = { index: turns.length, userText: text, blocks: [], timestamp: ts };
    turns.push(current);
    return current;
  };
  /** Blocks arriving before any user message still need a home. */
  const ensureTurn = (ts: string | null) => {
    if (!current) startTurn(null, ts);
    return current!;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // half-written final line of a live file — expected, never fatal
    }

    // Before any type dispatch: every `continue` below would otherwise skip an
    // entry that still counts as activity. Last-wins rather than max, because
    // the file is append-only and its entries are already in order.
    if (typeof entry?.timestamp === "string") lastTimestamp = entry.timestamp;

    const type = entry?.type;

    if (type === "ai-title") {
      if (typeof entry.aiTitle === "string") title = entry.aiTitle;
      continue;
    }

    if (!CONSUMED.has(type)) {
      if (!IGNORED.has(type)) {
        ensureTurn(entry?.timestamp ?? null).blocks.push({
          kind: "unknown",
          entryType: String(type),
        });
      }
      continue;
    }

    if (entry.isSidechain) continue; // subagent content; out of scope for v1

    if (type === "user") {
      const content = entry.message?.content;
      // Tool results attach to the tool_use already recorded in this turn.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const tool = pendingTools.get(b.tool_use_id);
          if (tool) tool.result = flattenContent(b.content);
        }
      }
      if (isHumanMessage(entry)) {
        const turn = startTurn(userText(entry), entry.timestamp ?? null);
        // A pasted screenshot must be visible as *something*. 88 real user
        // image blocks across 20 sessions; base64 never carried forward.
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "image") turn.blocks.push({ kind: "image" });
          }
        }
      }
      continue;
    }

    // Do NOT dedupe by message.id. One streamed message is written across
    // several lines under a single id, each carrying the next content block.
    // Verified: 6388 id-repeats carry differing content, zero carry identical
    // content. Keep-first dedupe discarded ~83% of all assistant blocks.
    const msg = entry.message;
    const turn = ensureTurn(entry.timestamp ?? null);
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    for (const b of blocks) {
      switch (b?.type) {
        case "text":
          if (b.text) turn.blocks.push({ kind: "text", text: b.text });
          break;
        case "thinking":
          if (b.thinking) turn.blocks.push({ kind: "thinking", text: b.thinking });
          break;
        case "tool_use": {
          const tool = {
            kind: "tool" as const,
            name: String(b.name ?? "unknown"),
            summary: toolSummary(b.input),
            input: b.input,
            result: null as string | null,
          };
          turn.blocks.push(tool);
          if (typeof b.id === "string") pendingTools.set(b.id, tool);
          break;
        }
        case "image":
          turn.blocks.push({ kind: "image" }); // never carry base64 forward
          break;
      }
    }
  }

  return { title, turns, lastTimestamp };
}
