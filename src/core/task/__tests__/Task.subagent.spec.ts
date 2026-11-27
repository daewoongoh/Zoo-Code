// npx vitest run core/task/__tests__/Task.subagent.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import { TelemetryService } from "@roo-code/telemetry"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import type { SubagentDefinition, SubagentRunSnapshot } from "@roo-code/types"

import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import type { AssistantMessageContent } from "../../assistant-message/types"
import type { ClineProvider } from "../../webview/ClineProvider"
import { Task } from "../Task"
import type { SubagentToolOutcome } from "../../subagents/types"

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../ignore/RooIgnoreController")

const definition: SubagentDefinition = {
	name: "explore",
	description: "Explores",
	systemPrompt: "Explore.",
	source: "builtin",
	readonly: true,
}

function makeProvider() {
	const finalizeGroup = vi.fn(async () => undefined)

	const provider = {
		log: vi.fn(),
		context: makeExtensionContext({ globalStorageUri: makeUri("/mock/global-storage") }),
		getState: vi.fn(async () => ({ mode: "code", currentApiConfigName: "default" })),
		getSubagentManager: () => ({ finalizeGroup }),
		postMessageToWebview: vi.fn(async () => undefined),
		postStateToWebviewThrottled: vi.fn(async () => undefined),
		updateTaskHistory: vi.fn(async () => undefined),
		taskHistoryStore: { get: vi.fn(() => undefined) },
	}

	return { provider, finalizeGroup }
}

function makeTask({ headless = false }: { headless?: boolean } = {}) {
	const { provider, finalizeGroup } = makeProvider()

	const task = new Task({
		provider: provider as unknown as ClineProvider,
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "test-api-key" },
		task: "parent task",
		startTask: false,
		parentTaskId: "parent-1",
		...(headless ? { subagent: { runId: "child-1", groupId: "group-1", definition }, maxTurns: 5 } : {}),
	})

	return { task, provider, finalizeGroup }
}

const outcome = (runId: string, overrides: Partial<SubagentToolOutcome> = {}): SubagentToolOutcome => ({
	runId,
	agentName: "explore",
	status: "completed",
	summary: `${runId} summary`,
	filesRead: [],
	filesModified: [],
	toolCallCount: 1,
	tokenUsage: { input: 10, output: 5 },
	...overrides,
})

const toolResults = (task: Task) =>
	task.userMessageContent.filter(
		(block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
	)

describe("Task subagent batch", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	it("pushes one tool_result per spawn in call order, regardless of completion order", async () => {
		const { task, finalizeGroup } = makeTask()
		const groupId = task.getSubagentGroupId("tool-1")
		const toolResultsBefore = toolResults(task).length

		let resolveFirst!: (value: SubagentToolOutcome) => void
		let resolveSecond!: (value: SubagentToolOutcome) => void

		task.registerSubagentCall(
			"tool-1",
			new Promise<SubagentToolOutcome>((resolve) => {
				resolveFirst = resolve
			}),
		)
		task.registerSubagentCall(
			"tool-2",
			new Promise<SubagentToolOutcome>((resolve) => {
				resolveSecond = resolve
			}),
		)

		expect(task.hasQueuedSubagentBatch()).toBe(true)

		const batch = task.runSubagentBatch({ immediate: true })
		resolveSecond(outcome("run-2", { summary: "second finished" }))
		resolveFirst(outcome("run-1", { summary: "first finished" }))
		await batch

		const results = toolResults(task).slice(toolResultsBefore)

		expect(results.map((result) => result.tool_use_id)).toEqual(["tool-1", "tool-2"])
		expect(results[0].content).toContain("first finished")
		expect(results[1].content).toContain("second finished")
		expect(task.hasQueuedSubagentBatch()).toBe(false)
		expect(task.userMessageContentReady).toBe(true)
		expect(task["currentSubagentGroupId"]).toBeUndefined()
		expect(finalizeGroup).toHaveBeenCalledWith(groupId)
	})

	it("keeps parent context isolated: only the structured summary reaches the parent turn", async () => {
		const { task } = makeTask()
		const clineMessagesBefore = task.clineMessages.length
		const apiHistoryBefore = [...task.apiConversationHistory]

		task.registerSubagentCall("tool-1", Promise.resolve(outcome("run-1")))

		await task.runSubagentBatch({ immediate: true })

		const results = toolResults(task)

		expect(results).toHaveLength(1)
		expect(results[0].content).toContain('Subagent "explore" completed')
		expect(results[0].content).toContain("run-1 summary")
		expect(task.clineMessages).toHaveLength(clineMessagesBefore)
		expect(task.apiConversationHistory).toEqual(apiHistoryBefore)
	})

	it("marks a failed run as a tool error and survives a rejected promise", async () => {
		const { task } = makeTask()

		task.registerSubagentCall(
			"tool-1",
			Promise.reject(new Error("runner exploded")) as Promise<SubagentToolOutcome>,
		)
		task.registerSubagentCall(
			"tool-2",
			Promise.resolve(outcome("run-2", { status: "failed", error: "no completion", summary: "" })),
		)

		await task.runSubagentBatch({ immediate: true })

		const [rejected, failed] = toolResults(task)

		expect(rejected).toMatchObject({ tool_use_id: "tool-1", is_error: true })
		expect(rejected.content).toContain("runner exploded")
		expect(failed).toMatchObject({ tool_use_id: "tool-2", is_error: true })
	})

	it("waits for the assistant turn to finish presenting before settling", async () => {
		const { task } = makeTask()
		let settled = false

		task.registerSubagentCall("tool-1", Promise.resolve(outcome("run-1")))

		const batch = task.runSubagentBatch().then(() => {
			settled = true
		})

		await new Promise((resolve) => setTimeout(resolve, 5))
		expect(settled).toBe(false)

		task.didCompleteReadingStream = true
		task.currentStreamingContentIndex = task.assistantMessageContent.length
		await batch

		expect(settled).toBe(true)
		expect(task.userMessageContentReady).toBe(true)
	})

	it("releases the turn when a spawn request produced no run", async () => {
		const { task, finalizeGroup } = makeTask()

		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "tool-1",
				name: "spawn_subagent",
				params: {},
				partial: false,
			} as AssistantMessageContent,
		]
		task.didCompleteReadingStream = true
		task.currentStreamingContentIndex = 1

		await task.runSubagentBatch()

		expect(task.userMessageContentReady).toBe(true)
		expect(toolResults(task)).toHaveLength(0)
		expect(finalizeGroup).not.toHaveBeenCalled()
	})
})

describe("Task headless mode", () => {
	it("answers a completion_result ask without the webview and flags the stop", async () => {
		const { task, provider } = makeTask({ headless: true })

		const answer = await task.ask("completion_result", "final report")

		expect(answer).toEqual({ response: "yesButtonClicked" })
		expect(task.subagentStopRequested).toBe(true)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("answers a tool ask without the webview", async () => {
		const { task, provider } = makeTask({ headless: true })

		await expect(task.ask("tool", "{}")).resolves.toEqual({ response: "yesButtonClicked" })
		expect(task.subagentStopRequested).toBe(false)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("records the final summary when the run says completion_result", async () => {
		const { task } = makeTask({ headless: true })

		await task.say("completion_result", "the report")

		expect(task.subagentSummary).toBe("the report")
	})
})

describe("Task#updateSubagentGroupMessage", () => {
	it("writes the final runs onto the leader spawn row only", async () => {
		const { task } = makeTask()

		const leader = {
			type: "say" as const,
			say: "tool" as const,
			ts: 1,
			text: JSON.stringify({ tool: "spawnSubagent", runId: "group-1", groupId: "group-1" }),
		}
		const follower = {
			type: "say" as const,
			say: "tool" as const,
			ts: 2,
			text: JSON.stringify({ tool: "spawnSubagent", runId: "run-2", groupId: "group-1" }),
		}
		task.clineMessages.push(leader, follower)

		const runs: SubagentRunSnapshot[] = [
			{
				runId: "run-1",
				parentTaskId: "parent-1",
				toolUseId: "run-1",
				groupId: "group-1",
				agentName: "explore",
				description: "Explore",
				modelId: "inherit",
				status: "completed",
				startedAt: 1,
				toolCallCount: 0,
				tokenUsage: { input: 0, output: 0 },
				filesRead: [],
				filesModified: [],
			},
		]

		await task.updateSubagentGroupMessage("group-1", runs)

		const leaderText = JSON.parse(leader.text) as { runs?: SubagentRunSnapshot[] }
		const followerText = JSON.parse(follower.text) as { runs?: SubagentRunSnapshot[] }

		expect(leaderText.runs).toEqual(runs)
		expect(followerText.runs).toBeUndefined()
	})
})
