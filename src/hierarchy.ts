import type { Task } from "./types.js";

export interface SubtaskSummary {
  completed: number;
  total: number;
  allCompleted: boolean;
}

export interface TaskHierarchy {
  tasks: Task[];
  tasksById: Map<string, Task>;
  parentByChild: Map<string, string>;
  childrenByParent: Map<string, Task[]>;
  roots: Task[];
  hasHierarchy: boolean;
}

export interface TaskHierarchyRow {
  task: Task;
  depth: number;
  connectorPrefix: string;
  parentId: string | undefined;
  summary: SubtaskSummary;
  readyToComplete: boolean;
  availableChildIds: string[];
  parallelSiblingIds: string[];
}

const STATUS_ORDER: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };

function byId(a: Task, b: Task): number {
  return Number(a.id) - Number(b.id);
}

export function byStatusThenId(a: Task, b: Task): number {
  const statusDelta = (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0);
  if (statusDelta !== 0) return statusDelta;
  return byId(a, b);
}

function findPrimaryParentId(task: Task, tasksById: Map<string, Task>): string | undefined {
  return (task.relations ?? []).find(relation => (
    relation.type === "parent" &&
    relation.target !== task.id &&
    tasksById.has(relation.target)
  ))?.target;
}

export function buildTaskHierarchy(tasks: Task[]): TaskHierarchy {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, Task[]>();

  for (const task of tasks) {
    const parentId = findPrimaryParentId(task, tasksById);
    if (!parentId) continue;
    parentByChild.set(task.id, parentId);
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(task);
    childrenByParent.set(parentId, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort(byId);
  }

  return {
    tasks,
    tasksById,
    parentByChild,
    childrenByParent,
    roots: tasks.filter(task => !parentByChild.has(task.id)),
    hasHierarchy: parentByChild.size > 0,
  };
}

export function getParentId(taskId: string, hierarchy: TaskHierarchy): string | undefined {
  return hierarchy.parentByChild.get(taskId);
}

export function getChildren(taskId: string, hierarchy: TaskHierarchy): Task[] {
  return hierarchy.childrenByParent.get(taskId) ?? [];
}

export function getDescendantIds(taskId: string, hierarchy: TaskHierarchy): string[] {
  const descendants: string[] = [];
  const seen = new Set<string>([taskId]);

  function visit(id: string) {
    for (const child of getChildren(id, hierarchy)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child.id);
      visit(child.id);
    }
  }

  visit(taskId);
  return descendants;
}

export function getSubtaskSummary(taskId: string, hierarchy: TaskHierarchy): SubtaskSummary {
  const descendants = getDescendantIds(taskId, hierarchy);
  const completed = descendants.filter(id => hierarchy.tasksById.get(id)?.status === "completed").length;
  return {
    completed,
    total: descendants.length,
    allCompleted: descendants.length > 0 && completed === descendants.length,
  };
}

export function getOpenBlockerIds(task: Task, hierarchy: TaskHierarchy): string[] {
  return task.blockedBy.filter(blockerId => {
    const blocker = hierarchy.tasksById.get(blockerId);
    return !blocker || blocker.status !== "completed";
  });
}

export function getAvailableChildIds(taskId: string, hierarchy: TaskHierarchy): string[] {
  return getChildren(taskId, hierarchy)
    .filter(child => child.status === "pending" && getOpenBlockerIds(child, hierarchy).length === 0)
    .map(child => child.id);
}

function hasHardOrderingBetween(a: Task, b: Task): boolean {
  return a.blocks.includes(b.id) || a.blockedBy.includes(b.id) || b.blocks.includes(a.id) || b.blockedBy.includes(a.id);
}

export function getParallelSiblingIds(taskId: string, hierarchy: TaskHierarchy): string[] {
  const task = hierarchy.tasksById.get(taskId);
  if (!task || task.status === "completed") return [];

  const parentId = getParentId(taskId, hierarchy);
  if (!parentId) return [];

  return getChildren(parentId, hierarchy)
    .filter(sibling => sibling.id !== taskId && sibling.status !== "completed" && !hasHardOrderingBetween(task, sibling))
    .map(sibling => sibling.id);
}

export function isReadyToComplete(task: Task, hierarchy: TaskHierarchy): boolean {
  const summary = getSubtaskSummary(task.id, hierarchy);
  return task.status !== "completed" && summary.allCompleted;
}

export function getReadyParentIds(hierarchy: TaskHierarchy): string[] {
  return hierarchy.tasks
    .filter(task => isReadyToComplete(task, hierarchy))
    .map(task => task.id);
}

export function flattenTaskHierarchy(hierarchy: TaskHierarchy): TaskHierarchyRow[] {
  const rows: TaskHierarchyRow[] = [];
  const emitted = new Set<string>();
  const rootOrder = hierarchy.hasHierarchy ? byId : byStatusThenId;

  function append(task: Task, depth: number, connectorPrefix: string, childPrefix: string, path: Set<string>) {
    if (emitted.has(task.id)) return;
    emitted.add(task.id);

    rows.push({
      task,
      depth,
      connectorPrefix,
      parentId: getParentId(task.id, hierarchy),
      summary: getSubtaskSummary(task.id, hierarchy),
      readyToComplete: isReadyToComplete(task, hierarchy),
      availableChildIds: getAvailableChildIds(task.id, hierarchy),
      parallelSiblingIds: getParallelSiblingIds(task.id, hierarchy),
    });

    if (path.has(task.id)) return;
    const nextPath = new Set(path);
    nextPath.add(task.id);
    const children = getChildren(task.id, hierarchy);
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const isLast = index === children.length - 1;
      append(
        child,
        depth + 1,
        `${childPrefix}${isLast ? "└─ " : "├─ "}`,
        `${childPrefix}${isLast ? "   " : "│  "}`,
        nextPath,
      );
    }
  }

  for (const root of [...hierarchy.roots].sort(rootOrder)) {
    append(root, 0, "", "", new Set());
  }

  for (const task of [...hierarchy.tasks].sort(byId)) {
    append(task, 0, "", "", new Set());
  }

  return rows;
}

export function formatTaskRefs(ids: string[]): string {
  return ids.map(id => `#${id}`).join(", ");
}
