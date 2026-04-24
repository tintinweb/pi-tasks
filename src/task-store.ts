/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

export interface TaskStoreLike {
  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>, options?: { status?: TaskStatus }): Task;
  get(id: string): Task | undefined;
  list(): Task[];
  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] };
  delete(id: string): boolean;
  clearAll(): number;
  deleteFileIfEmpty(): boolean;
  clearCompleted(): number;
  getState(): TaskStoreData;
  replaceState(data: TaskStoreData): void;
}

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 10;
const LOCK_MAX_RETRIES = 50; // 500ms max (10ms × 50)
const READ_CACHE_TTL_MS = 50;

/** Simple file-based locking with bounded retry. */
function acquireLock(lockPath: string): void {
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock file unreadable (race) — retry
        }
        Atomics.wait(sleepBuf, 0, 0, LOCK_RETRY_MS);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock after ${LOCK_MAX_RETRIES} retries: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch (e: any) {
    if (e.code !== "ENOENT") console.warn("[pi-tasks] lock release failed:", e.code);
  }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore implements TaskStoreLike {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();
  private lastLoadAt = 0;

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Read store from disk (file-backed mode only). */
  private load(force = false): void {
    if (!this.filePath) return;
    if (!force && Date.now() - this.lastLoadAt < READ_CACHE_TTL_MS) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (typeof raw?.nextId !== "number" || !Array.isArray(raw?.tasks)) return;
      const data = raw as TaskStoreData;
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const t of data.tasks) {
        this.tasks.set(t.id, t);
      }
      this.lastLoadAt = Date.now();
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      if (e instanceof SyntaxError) return;
      throw e;
    }
  }

  /** Write store to disk atomically (file-backed mode only). */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    const tmpPath = this.filePath + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      renameSync(tmpPath, this.filePath);
      this.lastLoadAt = Date.now();
    } catch (e) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw e;
    }
  }

  /** DFS cycle detection for dependency edges. */
  private hasCycle(fromId: string, toId: string): boolean {
    const visited = new Set<string>();
    const stack = [toId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === fromId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.tasks.get(current);
      if (task) {
        for (const dep of task.blocks) stack.push(dep);
      }
    }
    return false;
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load(true);
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>, options?: { status?: TaskStatus }): Task {
    return this.withLock(() => {
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: options?.status ?? "pending",
        activeForm,
        owner: undefined,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return task;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  /** List all tasks sorted by ID ascending. */
  list(): Task[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
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
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      // Handle deletion
      if (fields.status === "deleted") {
        this.tasks.delete(id);
        // Clean up dependency edges pointing to this task
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return { task: undefined, changedFields: ["deleted"], warnings: [] };
      }

      if (fields.status !== undefined) {
        task.status = fields.status;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }

      // Metadata: shallow merge, null deletes keys
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = value;
          }
        }
        changedFields.push("metadata");
      }

      // Bidirectional dependency edges
      if (fields.addBlocks && fields.addBlocks.length > 0) {
        for (const targetId of fields.addBlocks) {
          if (!task.blocks.includes(targetId)) {
            task.blocks.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blockedBy.includes(id)) {
            target.blockedBy.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (this.hasCycle(id, targetId)) {
            warnings.push(`cycle: #${id} → #${targetId} creates a dependency cycle`);
          }
        }
        changedFields.push("blocks");
      }

      if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
        for (const targetId of fields.addBlockedBy) {
          if (!task.blockedBy.includes(targetId)) {
            task.blockedBy.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blocks.includes(id)) {
            target.blocks.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (this.hasCycle(targetId, id)) {
            warnings.push(`cycle: #${id} ← #${targetId} creates a dependency cycle`);
          }
        }
        changedFields.push("blockedBy");
      }

      task.updatedAt = Date.now();
      return { task, changedFields, warnings };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      // Clean up dependency edges
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch (e: any) {
      if (e.code !== "ENOENT") console.warn("[pi-tasks] store file cleanup failed:", e.code);
    }
    return true;
  }

  /** Snapshot current state for external persistence/reconstruction. */
  getState(): TaskStoreData {
    if (this.filePath) this.load();
    return {
      nextId: this.nextId,
      tasks: this.list().map(task => ({
        ...task,
        metadata: { ...task.metadata },
        blocks: [...task.blocks],
        blockedBy: [...task.blockedBy],
      })),
    };
  }

  /** Replace all state from an external snapshot. */
  replaceState(data: TaskStoreData): void {
    this.withLock(() => {
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const task of data.tasks) {
        this.tasks.set(task.id, {
          ...task,
          metadata: { ...task.metadata },
          blocks: [...task.blocks],
          blockedBy: [...task.blockedBy],
        });
      }
    });
  }

  /** Remove all completed and skipped tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      const terminalIds = new Set<string>();
      for (const [id, task] of this.tasks) {
        if (task.status === "completed" || task.status === "skipped") terminalIds.add(id);
      }
      if (terminalIds.size === 0) return 0;

      for (const id of terminalIds) this.tasks.delete(id);
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => !terminalIds.has(bid));
        t.blockedBy = t.blockedBy.filter(bid => !terminalIds.has(bid));
      }
      return terminalIds.size;
    });
  }
}
