/**
 * Extracts reasoning text from a streaming delta object.
 *
 * Prefers `reasoning_content` (DeepSeek-R1 / QwQ style) and falls back to
 * `reasoning` (OpenRouter style). Returns `undefined` when neither field
 * carries non-blank text, so callers can decide whether to yield a chunk.
 */
export function extractReasoningFromDelta(delta: unknown): string | undefined {
	if (!delta) return undefined

	const d = delta as { reasoning_content?: unknown; reasoning?: unknown }
	const candidate =
		(typeof d.reasoning_content === "string" && d.reasoning_content) ||
		(typeof d.reasoning === "string" && d.reasoning) ||
		""

	return candidate.trim() ? candidate : undefined
}
