// npx vitest run core/subagents/__tests__/SubagentTool.spec.ts

import type { SubagentDefinition } from "@roo-code/types"

import type { ToolUse } from "../../../shared/tools"
import type { Task } from "../../task/Task"
import { subagentTool } from "../../tools/SubagentTool"
import type { SubagentManager } from "../SubagentManager"
import type { SubagentRegistry } from "../SubagentRegistry"
import type { SubagentToolOutcome } from "../types"

const definition: SubagentDefinition = {
	name: "explore",
	description: "Explores the codebase",
	systemPrompt: "Explore.",
	source: "builtin",
	readonly: true,
}

const spawnOutcome: SubagentToolOutcome = {
	runId: "tool-1",
	agentName: "explore",
	status: "completed",
	summary: "done",
	filesRead: [],
	filesModified: [],
	toolCallCount: 0,
	tokenUsage: { input: 0, output: 0 },
}

function makeHarness({ nested = false, enabled = true }: { nested?: boolean; enabled?: boolean } = {}) {
	const manager = { spawn: vi.fn(() => Promise.resolve(spawnOutcome)) }
	const registry = {
		get: vi.fn((name: string) => (name === "explore" ? definition : undefined)),
		getAll: vi.fn(() => [definition]),
	}
	const pushToolResult = vi.fn()
	const handleError = vi.fn()
	const say = vi.fn(async () => undefined)
	const registerSubagentCall = vi.fn()
	const sayAndCreateMissingParamError = vi.fn(async () => "missing parameter")

	// Mirrors `Task#getSubagentGroupId`: the first spawn of a turn names the group.
	let groupId: string | undefined

	const task = {
		subagent: nested ? { runId: "child", groupId: "group", definition } : undefined,
		providerRef: {
			deref: () => ({
				getSubagentManager: () => manager as unknown as SubagentManager,
				getSubagentRegistry: () => registry as unknown as SubagentRegistry,
				contextProxy: { getValue: vi.fn(() => enabled) },
			}),
		},
		getSubagentGroupId: vi.fn((toolUseId: string) => (groupId ??= toolUseId)),
		registerSubagentCall,
		say,
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError,
	} as unknown as Task

	const block = (nativeArgs: Record<string, unknown>, id = "tool-1"): ToolUse<"spawn_subagent"> =>
		({
			type: "tool_use",
			id,
			name: "spawn_subagent",
			params: {},
			partial: false,
			nativeArgs,
		}) as unknown as ToolUse<"spawn_subagent">

	const callbacksFor = (toolCallId = "tool-1") => ({
		askApproval: vi.fn(async () => true),
		handleError,
		pushToolResult,
		toolCallId,
	})

	const callbacks = callbacksFor()

	return {
		manager,
		registry,
		task,
		block,
		callbacks,
		callbacksFor,
		pushToolResult,
		registerSubagentCall,
		say,
		sayAndCreateMissingParamError,
	}
}

describe("SubagentTool", () => {
	it("starts a run, registers the promise and shows the spawn row without a tool result", async () => {
		const harness = makeHarness()

		await subagentTool.handle(
			harness.task,
			harness.block({ agent: "explore", description: "Find auth", prompt: "Locate auth" }),
			harness.callbacks,
		)

		expect(harness.manager.spawn).toHaveBeenCalledWith({
			parentTask: harness.task,
			definition,
			request: { agent: "explore", description: "Find auth", prompt: "Locate auth", model: undefined, isolation: undefined },
			runId: "tool-1",
			groupId: "tool-1",
			toolUseId: "tool-1",
		})
		expect(harness.registerSubagentCall).toHaveBeenCalledWith("tool-1", expect.any(Promise))
		expect(harness.say).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining('"tool":"spawnSubagent"'),
		)
		expect(harness.pushToolResult).not.toHaveBeenCalled()
	})

	it("shows one group row for a parallel batch instead of a row per spawn", async () => {
		const harness = makeHarness()
		const args = { agent: "explore", description: "Find auth", prompt: "Locate auth" }

		await subagentTool.handle(harness.task, harness.block(args, "tool-1"), harness.callbacksFor("tool-1"))
		await subagentTool.handle(harness.task, harness.block(args, "tool-2"), harness.callbacksFor("tool-2"))

		expect(harness.registerSubagentCall).toHaveBeenCalledTimes(2)
		expect(harness.say).toHaveBeenCalledTimes(1)
		expect(harness.manager.spawn).toHaveBeenLastCalledWith(
			expect.objectContaining({ runId: "tool-2", groupId: "tool-1" }),
		)
	})

	it("sanitizes the tool call id before using it as the run id", async () => {
		const harness = makeHarness()

		await subagentTool.handle(
			harness.task,
			harness.block({ agent: "explore", description: "Find auth", prompt: "Locate auth" }, "tool:1"),
			harness.callbacksFor("tool:1"),
		)

		expect(harness.manager.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "tool_1", groupId: "tool_1", toolUseId: "tool:1" }),
		)
	})

	it("refuses to spawn when the feature is disabled", async () => {
		const harness = makeHarness({ enabled: false })

		await subagentTool.handle(
			harness.task,
			harness.block({ agent: "explore", description: "Find auth", prompt: "Locate auth" }),
			harness.callbacks,
		)

		expect(harness.manager.spawn).not.toHaveBeenCalled()
		expect(harness.registerSubagentCall).not.toHaveBeenCalled()
		expect(harness.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subagents are disabled"))
	})

	it("refuses a nested spawn from inside a subagent run", async () => {
		const harness = makeHarness({ nested: true })

		await subagentTool.handle(
			harness.task,
			harness.block({ agent: "explore", description: "Nested", prompt: "Nested" }),
			harness.callbacks,
		)

		expect(harness.manager.spawn).not.toHaveBeenCalled()
		expect(harness.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("cannot spawn another subagent"),
		)
	})

	it("lists the available agents for an unknown name", async () => {
		const harness = makeHarness()

		await subagentTool.handle(
			harness.task,
			harness.block({ agent: "missing", description: "Find auth", prompt: "Locate auth" }),
			harness.callbacks,
		)

		expect(harness.manager.spawn).not.toHaveBeenCalled()
		expect(harness.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Available agents: explore"))
	})

	it("reports the missing parameter and counts a mistake", async () => {
		const harness = makeHarness()

		await subagentTool.handle(
			harness.task,
			harness.block({ description: "No agent", prompt: "Locate auth" }),
			harness.callbacks,
		)

		expect(harness.sayAndCreateMissingParamError).toHaveBeenCalledWith("spawn_subagent", "agent")
		expect(harness.pushToolResult).toHaveBeenCalledWith("missing parameter")
		expect(harness.manager.spawn).not.toHaveBeenCalled()
	})
})
