import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function mockCtx() {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand: vi.fn(),
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
  };

  return {
    pi,
    tools,
    async executeTool(name: string, params: any, ctx = mockCtx()) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      const result = await tool.execute("call-1", params, undefined, undefined, ctx);
      await this.fireLifecycle("tool_result", { toolName: name });
      return result;
    },
    async fireLifecycle(event: string, ...args: any[]) {
      let lastResult: any;
      for (const h of lifecycleHandlers.get(event) ?? []) {
        const result = await h(...args);
        if (result !== undefined) lastResult = result;
      }
      return lastResult;
    },
  };
}

function installPingResponder(pi: ReturnType<typeof mockPi>["pi"]) {
  return pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
}

describe("stale in_progress task reminders", () => {
  it("injects a task-specific reminder after text-only turns", async () => {
    const mock = mockPi();
    const unping = installPingResponder(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Finish stale reminder test", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", { message: { role: "assistant", usage: { input: 1, output: 1 } } });
    let contextResult = await mock.fireLifecycle("context", { messages: [] });
    expect(contextResult).toEqual({});

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", { message: { role: "assistant", usage: { input: 1, output: 1 } } });
    contextResult = await mock.fireLifecycle("context", { messages: [] });

    const reminder = contextResult.messages.at(-1).content[0].text;
    expect(reminder).toContain("#1 — Finish stale reminder test");
    expect(reminder).toContain("still marked as in_progress");
    expect(reminder).toContain("use TaskUpdate to mark them as completed");

    unping();
  });

  it("uses a shorter reminder interval for non-task tools when a task is in_progress", async () => {
    const mock = mockPi();
    const unping = installPingResponder(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Run validation", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("tool_result", { toolName: "read" });
    let contextResult = await mock.fireLifecycle("context", { messages: [] });
    expect(contextResult).toEqual({});

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("tool_result", { toolName: "bash" });
    contextResult = await mock.fireLifecycle("context", { messages: [] });

    const reminder = contextResult.messages.at(-1).content[0].text;
    expect(reminder).toContain("#1 — Run validation");
    expect(reminder).toContain("If you have completed any of these");

    unping();
  });
});
