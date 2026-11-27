import type {
	ClineAsk,
	ClineAskResponse,
	SubagentDefinition,
	SubagentRunSnapshot,
	SubagentTranscriptBlock,
} from "@roo-code/types"

/**
 * Result of a headless ask. Subagents never block on user input.
 */
export interface SubagentAskResult {
	response: ClineAskResponse
	text?: string
	images?: string[]
}

/**
 * Task-local hooks a headless subagent run installs on its `Task`.
 *
 * `Task` imports this type only, so the runner and the task loop stay free of a
 * runtime module cycle.
 */
export interface SubagentTaskContext {
	runId: string
	/** Shared by every spawn of the same parent turn. */
	groupId: string
	definition: SubagentDefinition
	/** Called as the child starts each tool call. Used for the live ticker. */
	onToolUse?: (toolName: string, params: Record<string, unknown>) => void
	/**
	 * Called each time the child appends a message to its own conversation
	 * history. Wires the live transcript; only the dedicated viewer consumes it.
	 */
	onTranscriptMessage?: (role: "user" | "assistant", blocks: SubagentTranscriptBlock[]) => void
	/** Resolves a headless ask without user interaction. */
	onAsk?: (type: ClineAsk, text?: string) => SubagentAskResult
}

/**
 * The value a queued `spawn_subagent` call resolves to. The parent receives
 * only this summary; child tool output never enters the parent conversation.
 */
export interface SubagentToolOutcome {
	runId: string
	agentName: string
	status: SubagentRunSnapshot["status"]
	summary: string
	error?: string
	partial?: boolean
	filesRead: string[]
	filesModified: string[]
	durationMs?: number
	toolCallCount: number
	tokenUsage: { input: number; output: number }
	transcriptPath?: string
	worktree?: SubagentRunSnapshot["worktree"]
}

/** Payload of a single queued `spawn_subagent` call. */
export interface SubagentSpawnRequest {
	agent: string
	description: string
	prompt: string
	model?: string
	isolation?: "none" | "worktree"
}
