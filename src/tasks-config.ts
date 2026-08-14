// <agent-dir>/tasks-config.json provides global defaults.
// <cwd>/.pi/tasks-config.json provides project overrides.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskSortOrder } from "./types.js";

const require = createRequire(import.meta.url);

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  collapseCompleted?: boolean;           // default: false
  showAll?: boolean;                     // default: false (expanded mode only)
  maxVisible?: number;                   // default: 10 (expanded mode only)
  sortOrder?: TaskSortOrder;              // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
}

function asTasksConfig(parsed: unknown): TasksConfig {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as TasksConfig : {};
}

function readTasksConfig(configPath: string): TasksConfig {
  try {
    return asTasksConfig(JSON.parse(readFileSync(configPath, "utf-8")));
  } catch {
    return {};
  }
}

function readExecutableTasksConfig(configPath: string): TasksConfig {
  if (!existsSync(configPath)) return {};
  try {
    const loaded = require(configPath) as unknown;
    return asTasksConfig((loaded as { default?: unknown })?.default ?? loaded);
  } catch {
    return {};
  }
}

export function loadTasksConfig(cwd = process.cwd(), agentDir = getAgentDir()): TasksConfig {
  const globalConfig = readTasksConfig(join(agentDir, "tasks-config.json"));
  const globalExecutableConfig = readExecutableTasksConfig(join(agentDir, "tasks-config.cjs"));
  const projectConfig = readTasksConfig(join(cwd, ".pi", "tasks-config.json"));
  const projectExecutableConfig = readExecutableTasksConfig(join(cwd, ".pi", "tasks-config.cjs"));
  return { ...globalConfig, ...globalExecutableConfig, ...projectConfig, ...projectExecutableConfig };
}

export function saveTasksConfig(config: TasksConfig, cwd = process.cwd(), agentDir = getAgentDir()): void {
  const configPath = join(cwd, ".pi", "tasks-config.json");
  const globalConfig = {
    ...readTasksConfig(join(agentDir, "tasks-config.json")),
    ...readExecutableTasksConfig(join(agentDir, "tasks-config.cjs")),
  };
  const projectOverrides = Object.fromEntries(Object.entries(config).filter(([key, value]) =>
    typeof value !== "function" && globalConfig[key as keyof TasksConfig] !== value
  ));
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectOverrides, null, 2));
}
