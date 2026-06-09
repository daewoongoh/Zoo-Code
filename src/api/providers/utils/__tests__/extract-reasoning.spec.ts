// npx vitest run api/providers/utils/__tests__/extract-reasoning.spec.ts

import { extractReasoningFromDelta } from "../extract-reasoning"

describe("extractReasoningFromDelta", () => {
	it("returns reasoning_content when present and non-blank", () => {
		expect(extractReasoningFromDelta({ reasoning_content: "thinking..." })).toBe("thinking...")
	})

	it("returns reasoning when reasoning_content is missing", () => {
		expect(extractReasoningFromDelta({ reasoning: "analyzing" })).toBe("analyzing")
	})

	it("prefers reasoning_content over reasoning when both are non-blank", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: "from_content",
				reasoning: "from_reasoning",
			}),
		).toBe("from_content")
	})

	it("falls back to reasoning when reasoning_content is null on the same delta", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: null,
				reasoning: "fallback",
			}),
		).toBe("fallback")
	})

	it("falls back to reasoning when reasoning_content is empty string", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: "",
				reasoning: "fallback",
			}),
		).toBe("fallback")
	})

	it("returns undefined for whitespace-only values", () => {
		expect(extractReasoningFromDelta({ reasoning_content: "   " })).toBeUndefined()
		expect(extractReasoningFromDelta({ reasoning: "\n\t" })).toBeUndefined()
	})

	it("returns undefined when neither field is present", () => {
		expect(extractReasoningFromDelta({ content: "hi" })).toBeUndefined()
	})

	it("returns undefined for nullish input", () => {
		expect(extractReasoningFromDelta(null)).toBeUndefined()
		expect(extractReasoningFromDelta(undefined)).toBeUndefined()
	})
})
