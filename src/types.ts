/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export type TaskRelationType = "parent" | "related" | "validates" | "supersedes" | "orderAfter" | (string & {});

export interface TaskRelation {
  type: TaskRelationType;
  target: string;
}

export interface TaskCreateInput {
  key?: string;
  subject: string;
  description: string;
  activeForm?: string;
  agentType?: string;
  metadata?: Record<string, any>;
  blocks?: string[];
  blockedBy?: string[];
  relations?: TaskRelation[];
}

export interface TaskUpdateFields {
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, any>;
  addBlocks?: string[];
  addBlockedBy?: string[];
  setRelations?: TaskRelation[];
  addRelations?: TaskRelation[];
  removeRelations?: TaskRelation[];
}

export interface TaskMutationResult {
  task: Task | undefined;
  changedFields: string[];
  warnings: string[];
}

export interface TaskCreateManyResult {
  tasks: Task[];
  warnings: string[];
}

export interface TaskUpdateManyResult {
  results: TaskMutationResult[];
  warnings: string[];
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any>;
  blocks: string[];
  blockedBy: string[];
  relations: TaskRelation[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
