// <cwd>/.pi/tasks-config.json — persists extension settings across sessions

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  nudgeInterval?: number;  // default: 4 (0 = disabled)
  autoClearCompleted?: boolean;  // default: false
}

const CONFIG_PATH = join(process.cwd(), ".pi", "tasks-config.json");

export function loadTasksConfig(): TasksConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Shape validation — must be a plain object, not an array or primitive
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
