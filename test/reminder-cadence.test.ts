import { beforeEach, describe, expect, it } from "vitest";

import {
	type CadenceConfig,
	type CadenceState,
	createCadenceState,
	drainReminderForContext,
	evaluateToolResult,
	onTurnStart,
	resetCadenceState,
} from "../src/reminder-cadence.js";

const TASK_TOOL_NAMES = new Set([
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
]);

const config: CadenceConfig = {
	reminderInterval: 4,
	taskToolNames: TASK_TOOL_NAMES,
};

describe("reminder cadence (pure)", () => {
	let state: CadenceState;

	beforeEach(() => {
		state = createCadenceState();
	});

	function advanceTurns(n: number): void {
		for (let i = 0; i < n; i++) onTurnStart(state);
	}

	it("starts with reminder not due", () => {
		expect(state.reminderDue).toBe(false);
		expect(drainReminderForContext(state)).toBe(false);
	});

	it("marks reminder due after REMINDER_INTERVAL non-task turns when tasks exist", () => {
		advanceTurns(5); // currentTurn = 5, lastTaskToolUseTurn = 0
		const decision = evaluateToolResult(state, "read", true, config);
		expect(decision.markDue).toBe(true);
		expect(state.reminderDue).toBe(true);
	});

	it("does NOT mark reminder due when no tasks exist", () => {
		advanceTurns(10);
		const decision = evaluateToolResult(state, "read", false, config);
		expect(decision.markDue).toBe(false);
		expect(state.reminderDue).toBe(false);
	});

	it("does NOT mark reminder due before the interval elapses", () => {
		advanceTurns(2);
		const decision = evaluateToolResult(state, "read", true, config);
		expect(decision.markDue).toBe(false);
		expect(state.reminderDue).toBe(false);
	});

	it("task tool usage resets cadence and clears any pending reminder", () => {
		advanceTurns(5);
		evaluateToolResult(state, "read", true, config); // queues reminder
		expect(state.reminderDue).toBe(true);

		const decision = evaluateToolResult(state, "TaskCreate", true, config);
		expect(decision.markDue).toBe(false);
		expect(state.reminderDue).toBe(false);
		expect(state.reminderInjectedThisCycle).toBe(false);
		expect(state.lastTaskToolUseTurn).toBe(state.currentTurn);
	});

	it("does not re-fire within the same injection cycle", () => {
		advanceTurns(5);
		evaluateToolResult(state, "read", true, config);
		expect(drainReminderForContext(state)).toBe(true);

		// Reminder injected this cycle — further non-task tool results should
		// not re-queue it until a task tool usage resets cadence.
		advanceTurns(10);
		const decision = evaluateToolResult(state, "bash", true, config);
		expect(decision.markDue).toBe(false);
		expect(state.reminderDue).toBe(false);
	});

	it("re-arms after a task tool usage resets the cycle", () => {
		advanceTurns(5);
		evaluateToolResult(state, "read", true, config);
		drainReminderForContext(state);

		// Use a task tool to reset.
		evaluateToolResult(state, "TaskUpdate", true, config);
		expect(state.reminderInjectedThisCycle).toBe(false);

		// Wait the interval again, expect a fresh reminder.
		advanceTurns(5);
		const decision = evaluateToolResult(state, "grep", true, config);
		expect(decision.markDue).toBe(true);
	});

	it("drainReminderForContext is a one-shot (only fires once per cycle)", () => {
		advanceTurns(5);
		evaluateToolResult(state, "read", true, config);

		expect(drainReminderForContext(state)).toBe(true);
		expect(drainReminderForContext(state)).toBe(false);
	});

	it("resetCadenceState wipes everything", () => {
		advanceTurns(20);
		evaluateToolResult(state, "read", true, config);
		drainReminderForContext(state);

		resetCadenceState(state);
		expect(state).toEqual({
			currentTurn: 0,
			lastTaskToolUseTurn: 0,
			reminderInjectedThisCycle: false,
			reminderDue: false,
		});
	});
});
