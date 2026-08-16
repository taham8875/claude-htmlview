import type { Block, Parsed, Turn } from "./transcript";

export type CodexParsed = Parsed & {
  id: string | null;
  cwd: string | null;
  isSubagent: boolean;
};

function textContent(content: unknown, type: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === type && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function toolInput(payload: Record<string, unknown>): unknown {
  const input = payload.input ?? payload.arguments;
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toolSummary(input: unknown): string {
  if (typeof input === "string") return input.length > 120 ? input.slice(0, 120) + "…" : input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  if (typeof record.description === "string") return record.description;
  for (const value of Object.values(record)) {
    if (typeof value === "string") return value.length > 120 ? value.slice(0, 120) + "…" : value;
  }
  return "";
}

function toolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function isSubagentMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") return true;
  if (!payload.source || typeof payload.source !== "object") return false;
  const subagent = (payload.source as Record<string, unknown>).subagent;
  return subagent !== undefined;
}

/** Normalize one Codex rollout file into the viewer's provider-neutral turn model. */
export function parseCodexTranscript(jsonl: string): CodexParsed {
  let id: string | null = null;
  let cwd: string | null = null;
  let isSubagent = false;
  let lastTimestamp: string | null = null;
  const turns: Turn[] = [];
  const pendingTools = new Map<string, Extract<Block, { kind: "tool" }>>();
  let current: Turn | null = null;

  const startTurn = (userText: string, timestamp: string | null) => {
    current = { index: turns.length, userText, blocks: [], timestamp };
    turns.push(current);
    return current;
  };

  const ensureTurn = (timestamp: string | null) => {
    if (!current) {
      current = { index: turns.length, userText: null, blocks: [], timestamp };
      turns.push(current);
    }
    return current;
  };

  let sawSessionMeta = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof entry.timestamp === "string") lastTimestamp = entry.timestamp;
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") continue;
    const item = payload as Record<string, unknown>;

    if (entry.type === "session_meta") {
      if (sawSessionMeta) continue;
      sawSessionMeta = true;
      const sessionId = item.id ?? item.session_id;
      if (typeof sessionId === "string") id = sessionId;
      if (typeof item.cwd === "string") cwd = item.cwd;
      isSubagent = isSubagentMeta(item);
      continue;
    }

    if (entry.type !== "response_item") continue;
    const itemType = item.type;

    if (itemType === "message") {
      if (item.role === "user") {
        const text = textContent(item.content, "input_text");
        const turn = startTurn(text, typeof entry.timestamp === "string" ? entry.timestamp : null);
        if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block?.type === "input_image") turn.blocks.push({ kind: "image" });
          }
        }
      } else if (item.role === "assistant") {
        const text = textContent(item.content, "output_text");
        if (text) ensureTurn(typeof entry.timestamp === "string" ? entry.timestamp : null).blocks.push({
          kind: "text",
          text,
        });
      }
      continue;
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const input = toolInput(item);
      const tool: Extract<Block, { kind: "tool" }> = {
        kind: "tool",
        name: typeof item.name === "string" ? item.name : "unknown",
        summary: toolSummary(input),
        input,
        result: null,
      };
      ensureTurn(typeof entry.timestamp === "string" ? entry.timestamp : null).blocks.push(tool);
      if (typeof item.call_id === "string") pendingTools.set(item.call_id, tool);
      continue;
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      if (typeof item.call_id === "string") {
        const tool = pendingTools.get(item.call_id);
        if (tool) tool.result = toolOutput(item.output);
      }
      continue;
    }

    if (itemType !== "reasoning") {
      ensureTurn(typeof entry.timestamp === "string" ? entry.timestamp : null).blocks.push({
        kind: "unknown",
        entryType: String(itemType),
      });
    }
  }

  const title = turns.find((turn) => turn.userText?.trim())?.userText?.slice(0, 80) ?? null;
  return { id, cwd, isSubagent, title, turns, lastTimestamp };
}
