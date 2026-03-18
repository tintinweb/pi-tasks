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
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { return {}; }
}

export function saveTasksConfig(config: TasksConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
