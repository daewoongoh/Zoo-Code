import type OpenAI from "openai"

import { isForbiddenSubagentTool, type SubagentDefinition } from "@roo-code/types"

/**
 * Tools a read-only subagent may keep even when its definition lists no
 * explicit tool set. Everything that can mutate the workspace, run commands or
 * start other work is excluded.
 */
export const SUBAGENT_READONLY_TOOLS = new Set([
	"read_file",
	"search_files",
	"list_files",
	"codebase_search",
	"read_command_output",
	"attempt_completion",
])

function toolName(tool: OpenAI.Chat.ChatCompletionTool): string | undefined {
	return "function" in tool ? tool.function?.name : undefined
}

/**
 * Applies the subagent definition to a built tool array.
 *
 * The order is deliberate: the flat-hierarchy ban wins over everything, then
 * the definition's own deny list, then its allow list, and finally the
 * read-only class restriction. A definition can therefore never re-enable a
 * forbidden tool.
 */
export function filterToolsForSubagent(
	tools: OpenAI.Chat.ChatCompletionTool[],
	definition: SubagentDefinition,
): OpenAI.Chat.ChatCompletionTool[] {
	const allowed = definition.tools ? new Set(definition.tools) : undefined
	const disallowed = new Set(definition.disallowedTools ?? [])

	return tools.filter((tool) => {
		const name = toolName(tool)

		if (!name) {
			return true
		}

		if (isForbiddenSubagentTool(name)) {
			return false
		}

		if (disallowed.has(name)) {
			return false
		}

		if (allowed && !allowed.has(name)) {
			return false
		}

		if (definition.readonly === true && !SUBAGENT_READONLY_TOOLS.has(name)) {
			return false
		}

		return true
	})
}

/**
 * Restricts the provider's callable-name list the same way the tool array is
 * restricted, for providers that see all definitions but may call only a
 * subset.
 */
export function filterAllowedFunctionNamesForSubagent(
	names: string[] | undefined,
	definition: SubagentDefinition,
): string[] | undefined {
	if (!names) {
		return undefined
	}

	const allowed = definition.tools ? new Set(definition.tools) : undefined
	const disallowed = new Set(definition.disallowedTools ?? [])

	return names.filter((name) => {
		if (isForbiddenSubagentTool(name)) {
			return false
		}
		if (disallowed.has(name)) {
			return false
		}
		if (allowed && !allowed.has(name)) {
			return false
		}
		if (definition.readonly === true && !SUBAGENT_READONLY_TOOLS.has(name)) {
			return false
		}
		return true
	})
}
