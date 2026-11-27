import type OpenAI from "openai"

/**
 * Native tool definition for `spawn_subagent`.
 *
 * The description is replaced at request time with one that lists the
 * available agent names and their one-line descriptions, so the parent pays
 * only a small, bounded prompt cost per agent.
 */
const spawnSubagent: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "spawn_subagent",
		// Do not use strict mode: `model` and `isolation` are optional, and a
		// strict schema forces every property into `required`, which pressures
		// the model to invent a value for optional fields (and often to emit an
		// empty argument object instead). Same rationale as `read_command_output`.
		description:
			"Delegate an isolated investigation or implementation to a subagent. The subagent works in its own context and returns only a final summary; its tool output never enters this conversation. Call this tool multiple times in one response to run agents in parallel. Do not use it for work you can finish with a single read or edit. Only the agent, description and prompt arguments are required; model and isolation are optional.",
		parameters: {
			type: "object",
			properties: {
				agent: {
					type: "string",
					description: "The subagent to run, by name. Use one of the agents listed in this tool description.",
				},
				description: {
					type: "string",
					description:
						"A short title for the UI card, 5-10 words. Example: 'Trace JWT refresh failures'.",
				},
				prompt: {
					type: "string",
					description:
						"Complete instructions for the subagent. It cannot ask you questions, so include every file, symptom, constraint and expected output format it needs.",
				},
				model: {
					type: "string",
					description: "Optional model id override for this run. Omit to inherit the parent model.",
				},
				isolation: {
					type: "string",
					enum: ["none", "worktree"],
					description:
						"Use 'worktree' when the subagent edits files, so its changes stay off this workspace until you review them. Defaults to 'none'.",
				},
			},
			required: ["agent", "description", "prompt"],
			additionalProperties: false,
		},
	},
}

export default spawnSubagent
