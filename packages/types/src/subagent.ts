import { z } from "zod"

/**
 * Native subagent definitions and run snapshots.
 *
 * A subagent is a headless child run that never becomes the active webview
 * task. The parent task keeps the chat screen; each subagent streams state
 * through `subagentUpdate` messages instead of `clineMessages`.
 */

export const subagentStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const

export const subagentStatusSchema = z.enum(subagentStatuses)

export type SubagentStatus = z.infer<typeof subagentStatusSchema>

export const subagentIsolationModes = ["none", "worktree"] as const

export const subagentIsolationSchema = z.enum(subagentIsolationModes)

export type SubagentIsolation = z.infer<typeof subagentIsolationSchema>

export const subagentSources = ["builtin", "project", "user"] as const

export const subagentSourceSchema = z.enum(subagentSources)

export type SubagentSource = z.infer<typeof subagentSourceSchema>

/**
 * Built-in agent names. Custom agents may use any slug that passes
 * `subagentNameSchema`; the union with `string` keeps definitions open.
 */
export const builtinSubagentNames = ["explore", "reviewer", "general"] as const

export const subagentNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Agent names may contain letters, digits, hyphens and underscores")

export const subagentDefinitionSchema = z.object({
	name: subagentNameSchema,
	/** One or two lines injected into the parent's `spawn_subagent` tool description. */
	description: z.string().min(1).max(500),
	/** Full system prompt for the child session. */
	systemPrompt: z.string().min(1),
	/** Model id override, or "inherit" to use the parent task's model. */
	model: z.string().min(1).optional(),
	tools: z.array(z.string().min(1)).optional(),
	disallowedTools: z.array(z.string().min(1)).optional(),
	/** Read-only agents get read-class tools and run fully in parallel. */
	readonly: z.boolean().optional(),
	maxTurns: z.number().int().min(1).max(100).optional(),
	isolation: subagentIsolationSchema.optional(),
	color: z.string().optional(),
	source: subagentSourceSchema,
})

export type SubagentDefinition = z.infer<typeof subagentDefinitionSchema>

/**
 * YAML frontmatter accepted in `.zoo/agents/*.md` and `.claude/agents/*.md`.
 * `tools`/`disallowedTools` accept either a YAML list or a comma-separated
 * string, matching both Claude Code and hand-written files.
 */
const commaSeparated = z
	.union([z.array(z.string()), z.string()])
	.optional()
	.transform((value) => {
		if (value === undefined) {
			return undefined
		}

		const list = Array.isArray(value) ? value : value.split(",")

		return list.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
	})

export const subagentFrontmatterSchema = z.object({
	name: subagentNameSchema.optional(),
	description: z.string().min(1).max(500).optional(),
	model: z.string().min(1).optional(),
	tools: commaSeparated,
	disallowedTools: commaSeparated,
	readonly: z.boolean().optional(),
	maxTurns: z.number().int().min(1).max(100).optional(),
	isolation: subagentIsolationSchema.optional(),
	color: z.string().optional(),
})

export type SubagentFrontmatter = z.infer<typeof subagentFrontmatterSchema>

export const subagentTokenUsageSchema = z.object({
	input: z.number().min(0),
	output: z.number().min(0),
})

export type SubagentTokenUsage = z.infer<typeof subagentTokenUsageSchema>

/**
 * One live tool-call event in a subagent's activity feed. Stella sends only the
 * tool name and a short structural tag, never the tool's output, so the live
 * feed never leaks child context into the parent conversation.
 */
export const subagentToolActivitySchema = z.object({
	/** Stable per-run id (call counter). */
	id: z.number(),
	tool: z.string(),
	/** Localized label key, optional when we only know the raw tool name. */
	labelKey: z.string().optional(),
	path: z.string().optional(),
	ts: z.number(),
})

export type SubagentToolActivity = z.infer<typeof subagentToolActivitySchema>

/**
 * One block of a subagent's conversation, streamed to the live transcript
 * viewer. `toolResult` content is carried verbatim per the user's choice; the
 * viewer virtualizes so the DOM stays bounded.
 */
export const subagentTranscriptBlockSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("reasoning"), text: z.string() }),
	z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.string() }),
	z.object({ type: z.literal("tool_result"), id: z.string(), content: z.string() }),
])

export type SubagentTranscriptBlock = z.infer<typeof subagentTranscriptBlockSchema>

export const subagentToolActivityListSchema = z.array(subagentToolActivitySchema).max(50)

export const subagentRunSnapshotSchema = z.object({
	runId: z.string(),
	parentTaskId: z.string(),
	toolUseId: z.string(),
	groupId: z.string(),
	agentName: z.string(),
	description: z.string(),
	modelId: z.string(),
	status: subagentStatusSchema,
	startedAt: z.number(),
	completedAt: z.number().optional(),
	durationMs: z.number().min(0).optional(),
	/** Live one-line ticker, e.g. "Reading src/auth/jwt.ts...". */
	currentAction: z.string().optional(),
	/** Chronological feed of recent tool calls, newest last (bounded). */
	activity: subagentToolActivityListSchema.optional(),
	toolCallCount: z.number().min(0),
	tokenUsage: subagentTokenUsageSchema,
	summary: z.string().optional(),
	error: z.string().optional(),
	/** Set when the run stopped at `maxTurns` before finishing on its own. */
	partial: z.boolean().optional(),
	readonly: z.boolean().optional(),
	isolation: subagentIsolationSchema.optional(),
	/** Worktree path and diff summary for `isolation: "worktree"` runs. */
	worktree: z
		.object({
			path: z.string(),
			kept: z.boolean(),
			filesChanged: z.number().min(0).optional(),
			diffStat: z.string().optional(),
		})
		.optional(),
	filesRead: z.array(z.string()),
	filesModified: z.array(z.string()),
})

export type SubagentRunSnapshot = z.infer<typeof subagentRunSnapshotSchema>

export const subagentGroupStateSchema = z.object({
	groupId: z.string(),
	parentTaskId: z.string(),
	startedAt: z.number(),
	completedAt: z.number().optional(),
	runs: z.array(subagentRunSnapshotSchema),
})

export type SubagentGroupState = z.infer<typeof subagentGroupStateSchema>

/** Payload of the extension -> webview `subagentUpdate` message. */
export const subagentUpdatePayloadSchema = z.object({
	parentTaskId: z.string(),
	groupId: z.string(),
	runs: z.array(subagentRunSnapshotSchema),
})

export type SubagentUpdatePayload = z.infer<typeof subagentUpdatePayloadSchema>

/** One message of a subagent's live transcript, streamed to the live viewer. */
export const subagentTranscriptMessageSchema = z.object({
	runId: z.string(),
	groupId: z.string(),
	/** Monotonic ordering across chunks for "load earlier". */
	seq: z.number(),
	role: z.enum(["user", "assistant"]),
	blocks: z.array(subagentTranscriptBlockSchema),
})

export type SubagentTranscriptMessage = z.infer<typeof subagentTranscriptMessageSchema>

/** Minimal history-item metadata persisted for each subagent run. */
export const subagentHistoryMetaSchema = z.object({
	runId: z.string(),
	groupId: z.string(),
	parentTaskId: z.string(),
	agentName: z.string(),
	status: subagentStatusSchema,
	partial: z.boolean().optional(),
})

export type SubagentHistoryMeta = z.infer<typeof subagentHistoryMetaSchema>

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4
export const MIN_CONCURRENT_SUBAGENTS = 1
export const MAX_CONCURRENT_SUBAGENTS = 8
export const DEFAULT_SUBAGENT_MAX_TURNS = 15
export const MAX_SUBAGENT_MAX_TURNS = 100

/**
 * Tools a subagent may never call. This enforces the flat two-level hierarchy
 * and the non-interactive contract: no nested spawn, no task delegation, no
 * mode switching and no blocking question.
 */
export const SUBAGENT_FORBIDDEN_TOOLS = [
	"spawn_subagent",
	"resume_subagent",
	"new_task",
	"ask_followup_question",
	"switch_mode",
] as const

export type SubagentForbiddenTool = (typeof SUBAGENT_FORBIDDEN_TOOLS)[number]

export const isForbiddenSubagentTool = (toolName: string): boolean =>
	(SUBAGENT_FORBIDDEN_TOOLS as readonly string[]).includes(toolName)
