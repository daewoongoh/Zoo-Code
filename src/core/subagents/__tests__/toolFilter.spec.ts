// npx vitest run core/subagents/__tests__/toolFilter.spec.ts

import type OpenAI from "openai"
import type { SubagentDefinition } from "@roo-code/types"

import { filterAllowedFunctionNamesForSubagent, filterToolsForSubagent } from "../toolFilter"

const tool = (name: string): OpenAI.Chat.ChatCompletionTool => ({
	type: "function",
	function: { name, description: name, parameters: { type: "object", properties: {} } },
})

const toolNames = (tools: OpenAI.Chat.ChatCompletionTool[]) =>
	tools.map((entry) => ("function" in entry ? entry.function?.name : undefined))

const baseDefinition: SubagentDefinition = {
	name: "worker",
	description: "test",
	systemPrompt: "work",
	source: "builtin",
}

const ALL_TOOLS = [
	tool("read_file"),
	tool("list_files"),
	tool("write_to_file"),
	tool("execute_command"),
	tool("spawn_subagent"),
	tool("resume_subagent"),
	tool("new_task"),
	tool("ask_followup_question"),
	tool("switch_mode"),
	tool("attempt_completion"),
]

describe("filterToolsForSubagent", () => {
	it("always removes the forbidden tools, even when the definition allows them", () => {
		const names = toolNames(
			filterToolsForSubagent(ALL_TOOLS, { ...baseDefinition, tools: ["spawn_subagent", "new_task", "read_file"] }),
		)

		expect(names).toEqual(["read_file"])
	})

	it("keeps the definition allow list", () => {
		expect(toolNames(filterToolsForSubagent(ALL_TOOLS, { ...baseDefinition, tools: ["read_file", "list_files"] }))).toEqual(
			["read_file", "list_files"],
		)
	})

	it("applies the deny list before the allow list", () => {
		const names = toolNames(
			filterToolsForSubagent(ALL_TOOLS, {
				...baseDefinition,
				tools: ["read_file", "list_files"],
				disallowedTools: ["list_files"],
			}),
		)

		expect(names).toEqual(["read_file"])
	})

	it("limits a read-only agent to read-class tools and attempt_completion", () => {
		const names = toolNames(filterToolsForSubagent(ALL_TOOLS, { ...baseDefinition, readonly: true }))

		expect(names).toEqual(["read_file", "list_files", "attempt_completion"])
	})

	it("never lets a read-only agent keep a write tool through the allow list", () => {
		const names = toolNames(
			filterToolsForSubagent(ALL_TOOLS, {
				...baseDefinition,
				readonly: true,
				tools: ["write_to_file", "read_file"],
			}),
		)

		expect(names).toEqual(["read_file"])
	})
})

describe("filterAllowedFunctionNamesForSubagent", () => {
	it("returns undefined when the provider has no callable-name list", () => {
		expect(filterAllowedFunctionNamesForSubagent(undefined, baseDefinition)).toBeUndefined()
	})

	it("filters the same way as the tool array", () => {
		const names = filterAllowedFunctionNamesForSubagent(
			["read_file", "write_to_file", "spawn_subagent", "attempt_completion"],
			{ ...baseDefinition, readonly: true },
		)

		expect(names).toEqual(["read_file", "attempt_completion"])
	})
})
