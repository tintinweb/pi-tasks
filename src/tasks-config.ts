// <agent-dir>/tasks-config.json provides global defaults.
// <cwd>/.pi/tasks-config.json provides project overrides.
//
// Configuration is data, never code: there is deliberately no executable config
// file, because `.pi/` lives inside cloned repositories. Custom sort orders are
// expressed as JSON sort specs — see task-sort.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskSortOrder } from "./task-sort.js";

export interface TasksConfig {
  // "session" keeps per-session files in the workspace; "session-global" keeps them
  // under the agent directory instead. Same scope, different home — see task-paths.ts.
  taskScope?: "memory" | "session" | "session-global" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  collapseCompleted?: boolean;           // default: false
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: TaskSortOrder;             // default: "id"
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

export function loadGlobalTasksConfig(agentDir = getAgentDir()): TasksConfig {
  return readTasksConfig(join(agentDir, "tasks-config.json"));
}

export function loadTasksConfig(cwd: string, agentDir = getAgentDir()): TasksConfig {
  const globalConfig = loadGlobalTasksConfig(agentDir);
  const projectConfig = readTasksConfig(join(cwd, ".pi", "tasks-config.json"));
  return { ...globalConfig, ...projectConfig };
}

export function saveTasksConfig(config: TasksConfig, cwd: string, agentDir = getAgentDir()): void {
  const configPath = join(cwd, ".pi", "tasks-config.json");
  const globalConfig = loadGlobalTasksConfig(agentDir);
  // Compared as JSON so that object-valued settings (a custom sortOrder spec) are
  // matched by value; for the primitives this config holds it is equivalent to !==.
  const projectOverrides = Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    JSON.stringify(globalConfig[key as keyof TasksConfig]) !== JSON.stringify(value)
  ));
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectOverrides, null, 2));
}
