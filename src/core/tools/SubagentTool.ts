import type { SubagentSpawnRequest } from "../subagents/types"
import type { SpawnSubagentParams as ManagerSpawnParams } from "../subagents/SubagentManager"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"

interface SpawnSubagentToolParams {
	agent: string
	description: string
	prompt: string
	model?: string
	isolation?: "none" | "worktree"
}

/**
 * `spawn_subagent` starts one headless child and returns immediately.
 *
 * The parent's tool_result stays open until `Task#runSubagentBatch` collects
 * every spawn of the turn, so the child's output never enters this
 * conversation directly.
 */
export class SubagentTool extends BaseTool<"spawn_subagent"> {
	readonly name = "spawn_subagent" as const

	async execute(
		params: SpawnSubagentToolParams,
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { agent, description, prompt, model, isolation } = params
		const { pushToolResult, toolCallId } = callbacks

		if (task.subagent) {
			// Flat two-level hierarchy: a child can never spawn another child.
			pushToolResult(formatResponse.toolError("A subagent cannot spawn another subagent."))
			return
		}

		if (!agent || !description || !prompt) {
			task.consecutiveMistakeCount++
			task.recordToolError("spawn_subagent")
			const missing = !agent ? "agent" : !description ? "description" : "prompt"
			pushToolResult(await task.sayAndCreateMissingParamError("spawn_subagent", missing))
			return
		}

		const provider = task.providerRef.deref()

		if (!provider) {
			pushToolResult(formatResponse.toolError("Provider reference lost"))
			return
		}

		// The prompt omits the tool when the feature is off; enforce the same
		// flag at execution so a hallucinated call cannot start a child run.
		if (provider.contextProxy?.getValue("subagentsEnabled") !== true) {
			pushToolResult(
				formatResponse.toolError("Subagents are disabled. Turn them on in Settings > Subagents."),
			)
			return
		}

		const manager = provider.getSubagentManager?.()
		const registry = provider.getSubagentRegistry?.()

		if (!manager || !registry) {
			pushToolResult(formatResponse.toolError("Subagents are not available in this window."))
			return
		}

		const definition = registry.get(agent)

		if (!definition) {
			task.consecutiveMistakeCount++
			task.recordToolError("spawn_subagent")
			const available = registry
				.getAll()
				.map(({ name }) => name)
				.join(", ")
			pushToolResult(
				formatResponse.toolError(
					`Unknown subagent "${agent}". Available agents: ${available || "(none)"}.`,
				),
			)
			return
		}

		// The run id doubles as the child's storage directory name and worktree
		// path segment, so keep it to the same safe character set as tool ids.
		const runId = sanitizeToolUseId(toolCallId)
		const groupId = task.getSubagentGroupId(runId)
		const request: SubagentSpawnRequest = { agent, description, prompt, model, isolation }

		const spawnParams: ManagerSpawnParams = {
			parentTask: task,
			definition,
			request,
			runId,
			groupId,
			toolUseId: toolCallId,
		}

		const promise = manager.spawn(spawnParams)
		task.registerSubagentCall(toolCallId, promise)
		task.consecutiveMistakeCount = 0

		// Only the leader row renders, and it renders the whole group card.
		// A row per spawn would leave an empty block for every follower.
		if (runId === groupId) {
			await task.say(
				"tool",
				JSON.stringify({
					tool: "spawnSubagent",
					runId,
					groupId,
					agentName: definition.name,
					modelId: request.model ?? definition.model ?? "inherit",
					runStatus: "queued",
				}),
			)
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"spawn_subagent">): Promise<void> {
		// The group card appears once the complete call is dispatched; partial
		// spawns would create duplicate rows for one run.
	}
}

export const subagentTool = new SubagentTool()
