import { test, expect, afterAll } from "bun:test";
import { watchProjects, watchSessions } from "./watch";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every temp root is tracked and removed at the end. Without this the suite
// orphans a directory per test per run — 448 had accumulated under /tmp.
const roots: string[] = [];
const tmpRoot = async () => {
  const r = await mkdtemp(join(tmpdir(), "htmlview-w-"));
  roots.push(r);
  return r;
};
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

// Timing notes: these tests watch real fs events, so some timing dependence
// is unavoidable — debouncing is inherently about time. Margins below are
// deliberately generous (5-10x), based on measuring actual event delivery
// lag on this platform (writes 5ms apart landed within ~15ms of each other),
// not tight guesses. See task-8-report.md for the measurements.

test("fires when a session file changes", async () => {
  const root = await tmpRoot();
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "sess-1.jsonl"), "{}\n");

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 30);
  await sleep(50);
  await writeFile(join(proj, "sess-1.jsonl"), '{}\n{"a":1}\n');
  await sleep(300);
  handle.close();

  expect(seen).toContain("sess-1");
});

test("debounces a burst of writes into one event", async () => {
  const root = await tmpRoot();
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "sess-2.jsonl"), "{}\n");

  const seen: string[] = [];
  // debounce (80ms) is 8x the inter-write gap (10ms): even under heavy
  // scheduler load, consecutive write events landing within 80ms of each
  // other keep re-arming the same timer instead of letting it fire early.
  const handle = await watchProjects(root, (id) => seen.push(id), 80);
  await sleep(50);
  for (let i = 0; i < 5; i++) {
    await writeFile(join(proj, "sess-2.jsonl"), `{"n":${i}}\n`);
    await sleep(10);
  }
  await sleep(500); // 6x debounceMs, generous room for the trailing timer to fire
  handle.close();

  expect(seen.filter((s) => s === "sess-2").length).toBe(1);
});

test("ignores non-jsonl files", async () => {
  const root = await tmpRoot();
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 20);
  await sleep(50);
  await writeFile(join(proj, "notes.txt"), "hello");
  await sleep(200);
  handle.close();

  expect(seen.length).toBe(0);
});

test("close() stops delivering events", async () => {
  const root = await tmpRoot();
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 20);
  await sleep(50);
  handle.close();
  await writeFile(join(proj, "sess-3.jsonl"), "{}\n");
  await sleep(200);

  expect(seen.length).toBe(0);
});

test("does not throw on a missing projects dir", async () => {
  const handle = await watchProjects("/nonexistent/xyz", () => {}, 20);
  handle.close();
});

test("picks up a session file in a project dir created after startup", async () => {
  const root = await tmpRoot();

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 30);
  await sleep(50);
  const proj = join(root, "-home-taha-newproj");
  await mkdir(proj, { recursive: true });
  await sleep(80); // let the root watcher react and attach a sub-watcher
  await writeFile(join(proj, "sess-4.jsonl"), "{}\n");
  await sleep(300);
  handle.close();

  expect(seen).toContain("sess-4");
});

test("does not crash when a watched project dir is removed", async () => {
  const root = await tmpRoot();
  const proj = join(root, "-home-taha-demo");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "sess-5.jsonl"), "{}\n");

  const seen: string[] = [];
  const handle = await watchProjects(root, (id) => seen.push(id), 20);
  await sleep(50);
  await rm(proj, { recursive: true, force: true });
  await sleep(200);
  // If the underlying watcher emitted an unhandled 'error' for the removed
  // directory, the process would have crashed before reaching this line.
  handle.close();
  expect(true).toBe(true);
});

test("watches existing and newly-created Codex date directories with qualified IDs", async () => {
  const claudeRoot = await tmpRoot();
  const codexRoot = await tmpRoot();
  const existingDay = join(codexRoot, "2026", "08", "17");
  await mkdir(existingDay, { recursive: true });
  const firstId = "019a1111-2222-7333-8444-555566667777";
  const firstFile = join(existingDay, `rollout-2026-08-17T10-00-00-${firstId}.jsonl`);
  await writeFile(firstFile, "{}\n");

  const seen: string[] = [];
  const handle = await watchSessions(
    { claudeProjectsDir: claudeRoot, codexSessionsDir: codexRoot },
    (id) => seen.push(id),
    30
  );
  await sleep(50);
  await writeFile(firstFile, '{"changed":true}\n');

  const secondId = "019a9999-8888-7777-8666-555544443333";
  const newDay = join(codexRoot, "2026", "08", "18");
  await mkdir(newDay);
  await sleep(100);
  await writeFile(join(newDay, `rollout-2026-08-18T10-00-00-${secondId}.jsonl`), "{}\n");
  await sleep(400);
  handle.close();

  expect(seen).toContain(`codex-${firstId}`);
  expect(seen).toContain(`codex-${secondId}`);
});
