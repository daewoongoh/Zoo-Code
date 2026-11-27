import type { SubagentTranscriptBlock } from "@roo-code/types"

/**
 * Convert the raw conversation content of one message plus its side-channel
 * reasoning into the flat `SubagentTranscriptBlock[]` handed to the live
 * transcript viewer.
 *
 * Content is carried verbatim (the user chose "full, no truncation"); the
 * viewer virtualizes so the DOM stays bounded. Images are dropped because the
 * viewer renders text only.
 */
export function toTranscriptBlocks(
	content: unknown,
	reasoning: string | undefined,
): SubagentTranscriptBlock[] {
	const blocks: SubagentTranscriptBlock[] = []

	if (typeof reasoning === "string" && reasoning.length > 0) {
		blocks.push({ type: "reasoning", text: reasoning })
	}

	if (!Array.isArray(content)) {
		return blocks
	}

	for (const raw of content) {
		const block = raw as { type?: string }
		switch (block.type) {
			case "text": {
				const text = (block as { text?: unknown }).text
				if (typeof text === "string") {
					blocks.push({ type: "text", text })
				}
				break
			}
			case "tool_use": {
				const b = block as { id?: unknown; name?: unknown; input?: unknown }
				blocks.push({
					type: "tool_use",
					id: String(b.id),
					name: typeof b.name === "string" ? b.name : "tool",
					input: safeJson(b.input),
				})
				break
			}
			case "tool_result": {
				const b = block as { tool_use_id?: unknown; content?: unknown }
				blocks.push({
					type: "tool_result",
					id: String(b.tool_use_id),
					content: stringifyToolResult(b.content),
				})
				break
			}
			default:
				// image and unknown block types are not rendered in the live viewer.
				break
		}
	}

	return blocks
}

function stringifyToolResult(content: unknown): string {
	if (typeof content === "string") {
		return content
	}

	if (Array.isArray(content)) {
		// Tool results commonly arrive as an array of { type, text } blocks.
		const parts = content.map((item) => {
			if (typeof item === "string") {
				return item
			}
			const text = (item as { text?: unknown }).text
			return typeof text === "string" ? text : safeJson(item)
		})
		return parts.join("\n")
	}

	return safeJson(content)
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "{}"
	} catch {
		return String(value)
	}
}
