/**
 * The widget spinner interval must not outlive the session. A live interval keeps
 * the event loop busy, so `pi -p` hung after its run settled whenever a task had
 * been set in_progress.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({}),
  loadTasksConfig: () => ({}),
  saveTasksConfig: () => {},
}));

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-shutdown-"));
  delete process.env.PI_TASKS;
  // Fake only intervals, so the timer count is exactly the spinner.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(cwd, { recursive: true, force: true });
});

async function startWithActiveTask() {
  const mock = mockPi();
  initExtension(mock.pi as any);
  const ctx = mockSessionCtx("s1", { cwd });
  await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
  await mock.executeTool("TaskCreate", { subject: "Spin", description: "d" }, ctx);
  await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
  return { mock, ctx };
}

describe("widget spinner lifecycle", () => {
  it("clears the spinner interval on session_shutdown", async () => {
    const { mock, ctx } = await startWithActiveTask();
    expect(vi.getTimerCount()).toBe(1);

    await mock.fireLifecycle("session_shutdown", { reason: "quit" }, ctx);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the spinner when a switched session still has an active task", async () => {
    const { mock, ctx } = await startWithActiveTask();

    await mock.fireLifecycle("session_shutdown", { reason: "resume" }, ctx);
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops the spinner when the run settles and restarts it on the next turn", async () => {
    const { mock, ctx } = await startWithActiveTask();
    expect(vi.getTimerCount()).toBe(1);

    await mock.fireLifecycle("agent_settled", {}, ctx);
    expect(vi.getTimerCount()).toBe(0);

    await mock.fireLifecycle("turn_start", {}, ctx);
    expect(vi.getTimerCount()).toBe(1);
  });
});
