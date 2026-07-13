// <agent-dir>/tasks-config.json provides global defaults.
// <cwd>/.pi/tasks-config.json provides project overrides.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: "id" | "status" | "recent" | "oldest";  // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
}

function readTasksConfig(configPath: string): TasksConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as TasksConfig : {};
  } catch {
    return {};
  }
}

export function loadTasksConfig(cwd = process.cwd(), agentDir = getAgentDir()): TasksConfig {
  const globalConfig = readTasksConfig(join(agentDir, "tasks-config.json"));
  const projectConfig = readTasksConfig(join(cwd, ".pi", "tasks-config.json"));
  return { ...globalConfig, ...projectConfig };
}

export function saveTasksConfig(config: TasksConfig, cwd = process.cwd(), agentDir = getAgentDir()): void {
  const configPath = join(cwd, ".pi", "tasks-config.json");
  const globalConfig = readTasksConfig(join(agentDir, "tasks-config.json"));
  const projectOverrides = Object.fromEntries(Object.entries(config).filter(([key, value]) => globalConfig[key as keyof TasksConfig] !== value));
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectOverrides, null, 2));
}
