import { expect, test } from "bun:test";
import { parseCodexTranscript } from "./codex-transcript";

const load = async (name: string) =>
  parseCodexTranscript(await Bun.file(`src/fixtures/${name}.jsonl`).text());

test("normalizes Codex messages, tools, and images into turns", async () => {
  const parsed = await load("codex-basic");

  expect(parsed.id).toBe("019a1111-2222-7333-8444-555566667777");
  expect(parsed.cwd).toBe("/home/taha/github/demo");
  expect(parsed.title).toBe("Check the Codex transcript");
  expect(parsed.turns).toHaveLength(2);
  expect(parsed.turns[0]!.userText).toBe("Check the Codex transcript");
  expect(parsed.turns[0]!.blocks.map((block) => block.kind)).toEqual([
    "image",
    "text",
    "tool",
    "tool",
    "text",
  ]);

  const tools = parsed.turns[0]!.blocks.filter((block) => block.kind === "tool");
  expect(tools).toHaveLength(2);
  expect(tools[0]).toMatchObject({
    name: "exec_command",
    input: { cmd: "pwd" },
    result: "/home/taha/github/demo",
  });
  expect(tools[1]).toMatchObject({
    name: "apply_patch",
    input: "*** Begin Patch",
    result: "Done!",
  });
});

test("ignores harness records, duplicate event mirrors, and encrypted reasoning", async () => {
  const parsed = await load("codex-basic");
  const serialized = JSON.stringify(parsed);

  expect(serialized).not.toContain("hidden project instructions");
  expect(serialized).not.toContain("hidden harness context");
  expect(serialized).not.toContain("hidden environment");
  expect(serialized).not.toContain("hidden skills");
  expect(serialized).not.toContain("hidden selected skill");
  expect(serialized).not.toContain("duplicate mirror");
  expect(serialized).not.toContain("opaque");
  expect(serialized).not.toContain("SECRET");
});

test("tracks activity from every record and tolerates a malformed line", async () => {
  const parsed = await load("codex-edge");

  expect(parsed.lastTimestamp).toBe("2026-08-17T11:00:02.000Z");
  expect(parsed.turns).toHaveLength(1);
  expect(parsed.turns[0]!.blocks).toContainEqual({
    kind: "unknown",
    entryType: "future_visible_item",
  });
});

test("identifies Codex subagent rollouts from session metadata", async () => {
  expect((await load("codex-edge")).isSubagent).toBe(true);
  expect((await load("codex-basic")).isSubagent).toBe(false);
});

test("keeps skill reads visible without exposing the skill document", () => {
  const parsed = parseCodexTranscript([
    JSON.stringify({
      timestamp: "2026-08-17T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: 'await tools.exec_command({ cmd: "sed -n 1,240p /skills/example/SKILL.md" })',
        call_id: "skill-read",
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-17T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "skill-read",
        output: [
          { type: "input_text", text: "Script completed" },
          {
            type: "input_text",
            text: "---\nname: example\ndescription: hidden\n---\n# Example Skill\nSecret workflow",
          },
        ],
      },
    }),
  ].join("\n"));

  expect(parsed.turns[0]!.blocks).toHaveLength(1);
  expect(parsed.turns[0]!.blocks[0]).toMatchObject({
    kind: "tool",
    name: "exec",
    result: null,
  });
});
