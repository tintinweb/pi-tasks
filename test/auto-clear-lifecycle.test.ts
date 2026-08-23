/**
 * Auto-clear driven through the real extension lifecycle: the reported case where a
 * finished list outlives the run that produced it and the next batch is appended to it
 * (#51, #56). The unit-level rules live in auto-clear.test.ts; this covers what the
 * tools and lifecycle events actually do to the store.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { sessionTaskFile } from "../src/task-paths.js";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-autoclear-"));
  config.current = {};
  delete process.env.PI_TASKS;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_TASKS;
  rmSync(cwd, { recursive: true, force: true });
});

const ctxFor = (sessionId = "s1") => mockSessionCtx(sessionId, { cwd });
const sessionFile = (sessionId: string) => sessionTaskFile(cwd, sessionId, "session");

type Mock = ReturnType<typeof mockPi>;

const listOf = async (mock: Mock, ctx: any): Promise<string> =>
  (await mock.executeTool("TaskList", {}, ctx)).content[0].text;

/** One run: a turn, `count` tasks created and completed, then the agent stops. */
async function runAndFinish(mock: Mock, ctx: any, count: number): Promise<void> {
  await mock.fireLifecycle("turn_start", {}, ctx);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await mock.executeTool("TaskCreate", { subject: `Task ${i}`, description: "d" }, ctx);
    ids.push(res.content[0].text.match(/#(\d+)/)![1]);
  }
  for (const id of ids) {
    await mock.executeTool("TaskUpdate", { taskId: id, status: "completed" }, ctx);
  }
  await mock.fireLifecycle("agent_settled", {}, ctx);
}

async function start(reason = "startup"): Promise<{ mock: Mock; ctx: any }> {
  const mock = mockPi();
  initExtension(mock.pi as any);
  const ctx = ctxFor();
  await mock.fireLifecycle("session_start", { reason }, ctx);
  return { mock, ctx };
}

describe("auto-clear across batches", () => {
  it("keeps the finished list visible after the run that produced it", async () => {
    const { mock, ctx } = await start();
    await runAndFinish(mock, ctx, 2);

    // The agent has stopped and the user is reading what was just completed.
    expect(await listOf(mock, ctx)).toContain("Task 0");
  });

  it("keeps it through a follow-up that creates no work", async () => {
    const { mock, ctx } = await start();
    await runAndFinish(mock, ctx, 2);

    await mock.fireLifecycle("turn_start", {}, ctx); // "what did you just do?"
    expect(await listOf(mock, ctx)).toContain("Task 0");
  });

  it("starts the next batch clean instead of appending to the finished one", async () => {
    const { mock, ctx } = await start();
    await runAndFinish(mock, ctx, 2);

    await mock.fireLifecycle("turn_start", {}, ctx);
    const created = await mock.executeTool("TaskCreate", { subject: "Fresh work", description: "d" }, ctx);

    const list = await listOf(mock, ctx);
    expect(list).toContain("Fresh work");
    expect(list).not.toContain("Task 0");
    expect(list).not.toContain("Task 1");
    // IDs stay monotonic — a shared list must never reuse one.
    expect(created.content[0].text).toContain("#3");
  });

  it("does the same after the session is resumed", async () => {
    const { mock, ctx } = await start();
    await runAndFinish(mock, ctx, 1);

    // Resume shows the completed list for review...
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);
    expect(await listOf(mock, ctx)).toContain("Task 0");

    // ...and it still does not collect the next batch.
    await mock.fireLifecycle("turn_start", {}, ctx);
    await mock.executeTool("TaskCreate", { subject: "Fresh work", description: "d" }, ctx);

    const list = await listOf(mock, ctx);
    expect(list).toContain("Fresh work");
    expect(list).not.toContain("Task 0");
  });

  it("keeps every step of a list the agent builds one task at a time", async () => {
    // An agent that creates a task, finishes it, then thinks of the next one is
    // building a single list — it is not starting a new batch each time.
    const { mock, ctx } = await start();
    for (const [i, subject] of ["Step one", "Step two", "Step three"].entries()) {
      await mock.fireLifecycle("turn_start", {}, ctx);
      await mock.executeTool("TaskCreate", { subject, description: "d" }, ctx);
      if (i < 2) await mock.executeTool("TaskUpdate", { taskId: String(i + 1), status: "completed" }, ctx);
    }

    const list = await listOf(mock, ctx);
    expect(list).toContain("Step one");
    expect(list).toContain("Step two");
    expect(list).toContain("Step three");
  });

  it("leaves unfinished work in place across the run boundary", async () => {
    const { mock, ctx } = await start();
    await mock.fireLifecycle("turn_start", {}, ctx);
    await mock.executeTool("TaskCreate", { subject: "Done", description: "d" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Unfinished", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" }, ctx);
    // The run ends with work still open, so the boundary is armed — but a list that
    // is not finished is not a batch to retire.
    await mock.fireLifecycle("agent_settled", {}, ctx);

    await mock.fireLifecycle("turn_start", {}, ctx);
    await mock.executeTool("TaskCreate", { subject: "More", description: "d" }, ctx);

    const list = await listOf(mock, ctx);
    expect(list).toContain("Unfinished");
    expect(list).toContain("Done");
  });

  it("keeps the list when auto-clear is off", async () => {
    config.current = { autoClearCompleted: "never" };
    const { mock, ctx } = await start();
    await runAndFinish(mock, ctx, 1);

    await mock.fireLifecycle("turn_start", {}, ctx);
    await mock.executeTool("TaskCreate", { subject: "Fresh work", description: "d" }, ctx);

    expect(await listOf(mock, ctx)).toContain("Task 0");
  });

  it("removes the emptied session file when the countdown clears the list", async () => {
    const { mock, ctx } = await start();
    await runAndFinish(mock, ctx, 1);
    expect(existsSync(sessionFile("s1"))).toBe(true);

    // The conversation continues without new tasks, so the turn countdown expires.
    for (let i = 0; i < 5; i++) await mock.fireLifecycle("turn_start", {}, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(false);
    // Only the file goes. `.pi/tasks/` is left standing, as every release so far
    // has left it — `.pi/` holds project config that is not ours to remove.
    expect(existsSync(join(cwd, ".pi", "tasks"))).toBe(true);
  });
});
