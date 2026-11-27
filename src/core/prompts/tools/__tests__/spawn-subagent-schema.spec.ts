// npx vitest run core/prompts/tools/__tests__/spawn-subagent-schema.spec.ts

import { getNativeTools } from "../native-tools"

function spawnSubagentTool() {
	const tool = getNativeTools().find(
		(t) => "function" in t && t.function?.name === "spawn_subagent",
	)
	if (!tool || !("function" in tool)) {
		throw new Error("spawn_subagent tool not advertised")
	}
	const fn = tool.function
	const parameters = fn.parameters as {
		properties?: Record<string, unknown>
		required?: string[]
	}
	return { fn, parameters }
}

describe("spawn_subagent native schema", () => {
	it("does not use strict mode, which would force optional fields into required", () => {
		// strict: true makes every property required, so the model must invent a
		// value for `model`/`isolation` and often emits an empty argument object
		// instead. The tool must stay loose like read_command_output.
		expect(spawnSubagentTool().fn.strict).not.toBe(true)
	})

	it("requires only the three real arguments and leaves model/isolation optional", () => {
		const { parameters } = spawnSubagentTool()
		expect(parameters.required).toEqual(["agent", "description", "prompt"])
		expect(parameters.properties).toHaveProperty("agent")
		expect(parameters.properties).toHaveProperty("description")
		expect(parameters.properties).toHaveProperty("prompt")
		expect(parameters.properties).toHaveProperty("model")
		expect(parameters.properties).toHaveProperty("isolation")
	})
})
