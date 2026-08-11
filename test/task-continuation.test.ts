import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function mockCtx(idle = true) {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    isIdle: vi.fn(() => idle),
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
    sendMessage: vi.fn(),
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const handlers = eventHandlers.get(channel);
          if (handlers) eventHandlers.set(channel, handlers.filter(item => item !== handler));
        };
      },
    },
  };

  return {
    pi,
    async executeTool(name: string, params: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, mockCtx());
    },
    async fireLifecycle(event: string, ...args: any[]) {
      let lastResult: any;
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        const result = await handler(...args);
        if (result !== undefined) lastResult = result;
      }
      return lastResult;
    },
  };
}

function installPingResponder(pi: ReturnType<typeof mockPi>["pi"]) {
  return pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: { version: 2 },
    });
  });
}

describe("continuing tasks after a user message", () => {
  it("injects the unfinished list immediately and resumes once after the answer", async () => {
    const mock = mockPi();
    const unping = installPingResponder(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Finish implementation", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    const inputResult = await mock.fireLifecycle("input", {
      text: "Why is this taking so long?",
      source: "interactive",
      streamingBehavior: "steer",
    }, mockCtx(false));
    expect(inputResult).toEqual({ action: "continue" });

    const contextResult = await mock.fireLifecycle("context", { messages: [] });
    const reminder = contextResult.messages.at(-1).content[0].text;
    expect(reminder).toContain('"content":"Finish implementation"');
    expect(reminder).toContain("Answer the user's latest message first");
    expect(reminder).toContain("continue working through the unfinished tasks in this same run");

    await mock.fireLifecycle("agent_settled", {}, mockCtx(true));
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    expect(mock.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "task-continuation",
        content: expect.stringContaining("Resume the task list now"),
        display: false,
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    // The continuation is one-shot, so an uncooperative model cannot create an
    // infinite settle/resume loop without another real user message.
    await mock.fireLifecycle("agent_settled", {}, mockCtx(true));
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();

    unping();
  });

  it("does not resume when the user explicitly pauses the work", async () => {
    const mock = mockPi();
    const unping = installPingResponder(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Keep working", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    await mock.fireLifecycle("input", {
      text: "Остановись, пожалуйста",
      source: "interactive",
      streamingBehavior: "steer",
    }, mockCtx(false));
    expect(await mock.fireLifecycle("context", { messages: [] })).toEqual({});

    await mock.fireLifecycle("agent_settled", {}, mockCtx(true));
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();

    unping();
  });

  it("does not resume when all tasks were completed while answering", async () => {
    const mock = mockPi();
    const unping = installPingResponder(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Answer and finish", description: "Desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    await mock.fireLifecycle("input", {
      text: "What is the current status?",
      source: "interactive",
    }, mockCtx());

    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    await mock.fireLifecycle("agent_settled", {}, mockCtx(true));

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
    unping();
  });

  it("waits for a genuinely idle settle event before queuing continuation", async () => {
    const mock = mockPi();
    const unping = installPingResponder(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "Resume later", description: "Desc" });
    await mock.fireLifecycle("input", {
      text: "Quick question",
      source: "interactive",
      streamingBehavior: "followUp",
    }, mockCtx(false));

    await mock.fireLifecycle("agent_settled", {}, mockCtx(false));
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();

    await mock.fireLifecycle("agent_settled", {}, mockCtx(true));
    expect(mock.pi.sendMessage).toHaveBeenCalledOnce();
    unping();
  });
});
