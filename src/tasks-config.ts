// <cwd>/.pi/tasks-config.json — persists extension settings across sessions

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskStorageLocation } from "./storage-paths.js";

export type TasksPersistenceBackend = "file" | "session_state";

export interface TasksConfig {
  persistenceBackend?: TasksPersistenceBackend;  // default: "session_state"
  taskScope?: "memory" | "session" | "project";  // default: "session"
  taskStorageLocation?: TaskStorageLocation;  // default: "local"
  autoCascade?: boolean;   // default: false
  nudgeInterval?: number;  // default: 4 (0 = disabled)
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
}

const CONFIG_PATH = join(process.cwd(), ".pi", "tasks-config.json");

export function loadTasksConfig(): TasksConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as TasksConfig;
  } catch (e: any) {
    if (e.code === "ENOENT" || e instanceof SyntaxError) return {};
    throw e;
  }
}

export function saveTasksConfig(config: TasksConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
