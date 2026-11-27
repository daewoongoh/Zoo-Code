import { describe, expect, it } from "vitest"

import { toTranscriptBlocks } from "../transcript"

describe("toTranscriptBlocks", () => {
	it("maps text, reasoning, tool_use and tool_result blocks in order", () => {
		const blocks = toTranscriptBlocks(
			[
				{ type: "text", text: "Let me check" },
				{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a.ts" } },
				{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] },
			],
			"reasoning here",
		)

		expect(blocks).toEqual([
			{ type: "reasoning", text: "reasoning here" },
			{ type: "text", text: "Let me check" },
			{ type: "tool_use", id: "t1", name: "read_file", input: '{\n  "path": "/a.ts"\n}' },
			{ type: "tool_result", id: "t1", content: "ok" },
		])
	})

	it("stringifies string tool results verbatim", () => {
		const [block] = toTranscriptBlocks([{ type: "tool_result", tool_use_id: "t9", content: "output" }], undefined)
		expect(block).toEqual({ type: "tool_result", id: "t9", content: "output" })
	})

	it("returns only reasoning when content is missing", () => {
		expect(toTranscriptBlocks(undefined, "reflection")).toEqual([{ type: "reasoning", text: "reflection" }])
	})
})
