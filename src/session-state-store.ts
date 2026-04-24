import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TaskStore, type TaskStoreLike } from "./task-store.js";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

export const TASKS_SESSION_STATE_TYPE = "pi-tasks-state";
export const TASKS_TOOL_DETAILS_VERSION = 1;

export interface TaskSessionStateDetails {
  version: number;
  backend: "session_state";
  state: TaskStoreData;
}

export class SessionStateTaskStore implements TaskStoreLike {
  private store = new TaskStore();

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>): Task {
    return this.store.create(subject, description, activeForm, metadata);
  }

  get(id: string): Task | undefined {
    return this.store.get(id);
  }

  list(): Task[] {
    return this.store.list();
  }

  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.store.update(id, fields);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  clearAll(): number {
    return this.store.clearAll();
  }

  deleteFileIfEmpty(): boolean {
    return false;
  }

  clearCompleted(): number {
    return this.store.clearCompleted();
  }

  getState(): TaskStoreData {
    return this.store.getState();
  }

  replaceState(data: TaskStoreData): void {
    this.store.replaceState(data);
  }
}

export function buildTaskSessionStateDetails(store: TaskStoreLike): TaskSessionStateDetails {
  return {
    version: TASKS_TOOL_DETAILS_VERSION,
    backend: "session_state",
    state: store.getState(),
  };
}

export function reconstructSessionStateStore(ctx: ExtensionContext, store: TaskStoreLike): void {
  let latestState: TaskStoreData | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg.role === "toolResult" && msg.toolName?.startsWith("Task")) {
        const details = msg.details as Partial<TaskSessionStateDetails> | undefined;
        if (details?.backend === "session_state" && details.state) {
          latestState = details.state as TaskStoreData;
        }
      }
      continue;
    }

    if (entry.type === "custom" && entry.customType === TASKS_SESSION_STATE_TYPE) {
      const data = entry.data as Partial<TaskSessionStateDetails> | undefined;
      if (data?.backend === "session_state" && data.state) {
        latestState = data.state as TaskStoreData;
      }
    }
  }

  if (latestState) {
    store.replaceState(latestState);
  } else {
    store.replaceState({ nextId: 1, tasks: [] });
  }
}
