/**
 * Per-task token usage belongs to one session.
 *
 * Task IDs restart at 1 in every session, and the widget keeps its metrics by task
 * ID. A session switch that leaves those metrics in place hands the previous
 * session's usage to whatever task happens to take the same ID next — and because
 * `activeTaskIds` also survives, every later turn keeps adding to it. A session
 * resumed a few times then shows a token total orders of magnitude larger than the
 * work it did, on a task that never ran.
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
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-usage-"));
  delete process.env.PI_TASKS;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

type Ctx = ReturnType<typeof mockSessionCtx>;

/**
 * The widget registers its renderer once and then asks the host to re-render, so a test reads the
 * renderer it registered and calls it again: the content closure reads the live store.
 */
const renderers = new Map<string, () => string[]>();

function capture(ctx: Ctx, key: string): void {
  const setWidget = ctx.ui.setWidget as unknown as (k: string, content: unknown, options?: unknown) => void;
  ctx.ui.setWidget = ((k: string, content: unknown, options?: unknown) => {
    setWidget(k, content, options);
    if (typeof content === "function") {
      const tui = { terminal: { columns: 200 }, requestRender: () => {} };
      const theme = { fg: (_c: string, text: string) => text, bold: (x: string) => x, strikethrough: (x: string) => x };
      renderers.set(key, () => (content as (a: unknown, b: unknown) => { render(): string[] })(tui, theme).render());
    }
  }) as unknown as typeof ctx.ui.setWidget;
}

/** The lines the widget renders now, from the renderer the given context registered. */
function rendered(key: string): string[] {
  return renderers.get(key)?.() ?? [];
}

/** One assistant turn reporting usage to the widget. */
async function turn(mock: ReturnType<typeof mockPi>, ctx: Ctx, input: number, output: number): Promise<void> {
  await mock.fireLifecycle(
    "turn_end",
    { turnIndex: 0, message: { role: "assistant", usage: { input, output } }, toolResults: [] },
    ctx,
  );
}

describe("token usage across a session switch", () => {
  it("counts a turn against the task in progress", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockSessionCtx("s1", { cwd });
    capture(ctx, "first");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Work", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);

    await turn(mock, ctx, 1000, 500);

    const line = rendered("first")?.find(l => l.includes("Work"));
    expect(line).toContain("↑ 1k");
    expect(line).toContain("↓ 500");
  });

  it("counts a turn delivered twice once", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockSessionCtx("s1", { cwd });
    capture(ctx, "twice");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Work", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);

    await mock.fireLifecycle(
      "turn_end",
      { turnIndex: 3, message: { role: "assistant", timestamp: 1700000000000, usage: { input: 1000, output: 500 } }, toolResults: [] },
      ctx,
    );
    await mock.fireLifecycle(
      "turn_end",
      { turnIndex: 3, message: { role: "assistant", timestamp: 1700000000000, usage: { input: 1000, output: 500 } }, toolResults: [] },
      ctx,
    );

    const line = rendered("twice").find(l => l.includes("Work"));
    expect(line).toContain("↑ 1k");
  });

  it("starts the next session's task at zero, whatever id it takes", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const first = mockSessionCtx("s1", { cwd });
    capture(first, "first");
    await mock.fireLifecycle("session_start", { reason: "startup" }, first);
    await mock.executeTool("TaskCreate", { subject: "Old work", description: "d" }, first);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, first);
    await turn(mock, first, 1000, 500);
    expect(rendered("first").some(l => l.includes("↑ 1k"))).toBe(true);

    const second = mockSessionCtx("s2", { cwd });
    capture(second, "second");
    await mock.fireLifecycle("session_start", { reason: "new" }, second);
    await mock.executeTool("TaskCreate", { subject: "New work", description: "d" }, second);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, second);
    await turn(mock, second, 10, 5);

    // The same widget renders for the new session; its task 1 is a different task.
    const line = rendered("first").find(l => l.includes("New work"));
    expect(line).toContain("↑ 10");
    expect(line).not.toContain("↑ 1k");
    expect(line).not.toContain("↓ 500");
  });
});
