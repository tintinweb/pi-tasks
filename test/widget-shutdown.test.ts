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
  it.each(["new", "resume", "fork"])("starts expanded after %s", async (reason) => {
    const { mock, ctx } = await startWithActiveTask();
    const factory = ctx.ui.setWidget.mock.calls.find(call => call[0] === "tasks" && call[1])?.[1];
    const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text };
    const component = factory({ mode: "fullscreen", terminal: { columns: 80 }, requestRender() {} }, theme);
    component.handleMouse({ type: "click", button: "left", y: 0 });
    expect(component.render()).toHaveLength(1);

    await mock.fireLifecycle("session_start", { reason }, ctx);
    expect(component.render().length).toBeGreaterThan(1);
    await mock.fireLifecycle("session_shutdown", { reason: "quit" }, ctx);
  });

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
});
