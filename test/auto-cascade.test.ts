/**
 * Auto-cascade: when enabled, completing an agent-backed task automatically starts
 * its unblocked dependents. Covers the state the cascade leaves behind, the
 * all-blockers-resolved gate, and what happens when a cascaded spawn fails.
 *
 * Prompt construction for cascaded agents is covered in subagent-integration.test.ts
 * ("Cascade data injection").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";

// Config is mocked rather than written to <cwd>/.pi/tasks-config.json: writing the
// real file would clobber the user's project settings, and reading it would let the
// developer's global <agentDir>/tasks-config.json leak into the results.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

describe("Auto-cascade (enabled)", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    delete process.env.PI_TASKS;
    config.current = { autoCascade: true, taskScope: "memory" };
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    // Cascade needs latestCtx, which only a lifecycle hook sets. Without this the
    // cascade silently no-ops and every assertion below would pass vacuously.
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(() => { rpc.unsub(); });

  /** Create an agent-backed task; returns its ID. */
  async function createAgentTask(subject: string) {
    const res = await mock.executeTool("TaskCreate", {
      subject,
      description: `do ${subject}`,
      agentType: "general-purpose",
    });
    return (res.content[0].text.match(/#(\d+)/) as RegExpMatchArray)[1];
  }

  it("starts a dependent task and records its agent when the blocker completes", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await flush();

    expect(rpc.spawned).toHaveLength(2);
    expect(rpc.spawned[1].type).toBe("general-purpose");
    expect(rpc.spawned[1].options.isBackground).toBe(true);

    const b = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(b.content[0].text).toContain("Status: in_progress");
    expect(b.content[0].text).toContain("Owner: agent-2");
    expect(b.content[0].text).toContain('"agentId":"agent-2"');
  });

  it("carries the launch model and turn limit into cascaded agents", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"], model: "haiku", max_turns: 7 });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await flush();

    expect(rpc.spawned[1].options.model).toBe("haiku");
    expect(rpc.spawned[1].options.maxTurns).toBe(7);
  });

  it("waits for every blocker, not just the one that completed", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await createAgentTask("Task C");
    await mock.executeTool("TaskUpdate", { taskId: "3", addBlockedBy: ["1", "2"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });
    expect(rpc.spawned).toHaveLength(2);

    // A done, B still running — C must stay put.
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "a" });
    await flush();
    expect(rpc.spawned).toHaveLength(2);
    expect((await mock.executeTool("TaskGet", { taskId: "3" })).content[0].text)
      .toContain("Status: pending");

    // B done too — now C cascades.
    mock.emitEvent("subagents:completed", { id: "agent-2", result: "b" });
    await flush();
    expect(rpc.spawned).toHaveLength(3);
  });

  it("does not cascade into tasks that do not depend on the completed one", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Unrelated");

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await flush();

    expect(rpc.spawned).toHaveLength(1);
    expect((await mock.executeTool("TaskGet", { taskId: "2" })).content[0].text)
      .toContain("Status: pending");
  });

  it("reverts a dependent to pending and records the error when its spawn fails", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Swap in a subagents extension that refuses to spawn, then complete A.
    rpc.unsub();
    const failing = installSubagentsMock(mock.pi, { spawnError: "no capacity" });
    try {
      mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
      await flush();

      expect(failing.spawned).toHaveLength(0);
      const b = await mock.executeTool("TaskGet", { taskId: "2" });
      expect(b.content[0].text).toContain("Status: pending");
      expect(b.content[0].text).toContain("no capacity");
    } finally {
      failing.unsub();
    }
  });

  it("chains through a three-task dependency line", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await createAgentTask("Task C");
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "3", addBlockedBy: ["2"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "a" });
    await flush();
    mock.emitEvent("subagents:completed", { id: "agent-2", result: "b" });
    await flush();

    expect(rpc.spawned).toHaveLength(3);
    expect((await mock.executeTool("TaskGet", { taskId: "3" })).content[0].text)
      .toContain("Status: in_progress");
  });

  it("does not cascade when the blocker fails", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "crashed", status: "error" });
    await flush();

    expect(rpc.spawned).toHaveLength(1);
  });
});
