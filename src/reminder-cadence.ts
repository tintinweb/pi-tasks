/**
 * Pure cadence logic for the system-reminder injection.
 *
 * Decisions are made here as plain functions so they're easy to unit-test
 * without spinning up the whole extension. The default export of the
 * extension wires these into the `tool_result` and `context` hooks.
 */

/** Internal cadence state. Plain object so it round-trips through tests. */
export interface CadenceState {
	currentTurn: number;
	lastTaskToolUseTurn: number;
	reminderInjectedThisCycle: boolean;
	reminderDue: boolean;
}

export interface CadenceConfig {
	/** Turns without a task-tool call before a reminder is considered due. */
	reminderInterval: number;
	/** Set of tool names that count as "task tool usage" and reset cadence. */
	taskToolNames: ReadonlySet<string>;
}

export function createCadenceState(): CadenceState {
	return {
		currentTurn: 0,
		lastTaskToolUseTurn: 0,
		reminderInjectedThisCycle: false,
		reminderDue: false,
	};
}

export function resetCadenceState(state: CadenceState): void {
	state.currentTurn = 0;
	state.lastTaskToolUseTurn = 0;
	state.reminderInjectedThisCycle = false;
	state.reminderDue = false;
}

/** Increment the turn counter at `turn_start`. */
export function onTurnStart(state: CadenceState): void {
	state.currentTurn++;
}

export interface ToolResultDecision {
	/** True when caller should mark `reminderDue` for the next `context` event. */
	markDue: boolean;
}

/**
 * Decide what cadence change a tool_result implies. Mutates `state` in place
 * (resets the timer when a task tool was used) and returns whether the
 * reminder should be queued for the next LLM call.
 */
export function evaluateToolResult(
	state: CadenceState,
	toolName: string,
	hasTasks: boolean,
	config: CadenceConfig,
): ToolResultDecision {
	// Task tool usage resets cadence and clears any pending reminder.
	if (config.taskToolNames.has(toolName)) {
		state.lastTaskToolUseTurn = state.currentTurn;
		state.reminderInjectedThisCycle = false;
		state.reminderDue = false;
		return { markDue: false };
	}

	// Cheap guards first.
	if (state.currentTurn - state.lastTaskToolUseTurn < config.reminderInterval) {
		return { markDue: false };
	}
	if (state.reminderInjectedThisCycle) return { markDue: false };
	if (!hasTasks) return { markDue: false };

	state.reminderDue = true;
	return { markDue: true };
}

/**
 * Drain the pending reminder when `context` fires. Returns true if the
 * caller should inject the reminder into the upcoming LLM call's messages.
 */
export function drainReminderForContext(state: CadenceState): boolean {
	if (!state.reminderDue) return false;
	state.reminderDue = false;
	state.reminderInjectedThisCycle = true;
	state.lastTaskToolUseTurn = state.currentTurn;
	return true;
}
