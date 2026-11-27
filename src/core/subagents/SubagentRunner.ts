import * as os from "os"
import * as path from "path"

import type {
	ClineAsk,
	ProviderSettings,
	SubagentDefinition,
	SubagentRunSnapshot,
	SubagentToolActivity,
	SubagentTranscriptMessage,
} from "@roo-code/types"

import { Task } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"
import { getTaskDirectoryPath } from "../../utils/storage"

import { finalizeSubagentWorktree, createSubagentWorktree } from "./worktree"
import type { SubagentAskResult, SubagentSpawnRequest, SubagentTaskContext, SubagentToolOutcome } from "./types"

const READ_TOOLS = new Set(["read_file"])
const WRITE_TOOLS = new Set(["write_to_file", "apply_diff", "edit", "search_and_replace", "edit_file", "apply_patch"])

/** Upper bound on the live activity feed kept in the run snapshot. */
const MAX_ACTIVITY = 50

/**
 * Tool name -> webview i18n key (namespace `chat:subagents.actions`). The feed
 * sends these structural keys instead of pre-translated strings so the owning
 * locale renders them.
 */
const SUBAGENT_ACTION_LABEL_KEYS: Record<string, string> = {
	read_file: "readfile",
	search_files: "searchfiles",
	list_files: "listfiles",
	codebase_search: "codebasesearch",
	execute_command: "executecommand",
	write_to_file: "writetofile",
	apply_diff: "editfile",
	edit: "editfile",
	search_and_replace: "editfile",
	edit_file: "editfile",
	apply_patch: "editfile",
	attempt_completion: "completion",
}

export interface RunSubagentOptions {
	provider: ClineProvider
	parentTask: Task
	definition: SubagentDefinition
	request: SubagentSpawnRequest
	runId: string
	groupId: string
	toolUseId: string
	maxTurns: number
	/** Receives the live snapshot patches for the group card. */
	onProgress: (patch: Partial<SubagentRunSnapshot>) => void
	/** Receives the live transcript messages for the dedicated viewer. */
	onTranscript?: (message: SubagentTranscriptMessage) => void
	log?: (message: string) => void
}

function resolveModelConfiguration(base: ProviderSettings, override?: string): ProviderSettings {
	if (!override || override === "inherit") {
		return base
	}

	return { ...base, apiModelId: override }
}

function extractPath(params: Record<string, unknown>): string | undefined {
	const candidate = params.path ?? params.file_path
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

/**
 * Executes one headless subagent run.
 *
 * The runner owns the child `Task` lifetime: it creates the isolated
 * workspace (when requested), installs the non-interactive ask policy, tracks
 * progress for the live card, and converts the run into a single
 * `SubagentToolOutcome` for the parent.
 */
export class SubagentRunner {
	private task?: Task
	private cancelled = false
	private toolCallCount = 0
	private readonly filesRead = new Set<string>()
	private readonly filesModified = new Set<string>()
	private startedAt = Date.now()
	private lastAction?: string
	private readonly activity: SubagentToolActivity[] = []
	private transcriptSeq = 0
	private transcriptListener?: (message: SubagentTranscriptMessage) => void

	constructor(private readonly options: RunSubagentOptions) {}

	requestCancel(): void {
		this.cancelled = true
		void this.task?.abortTask(true).catch(() => {
			// Abort is best-effort; the promise settlement below owns the outcome.
		})
	}

	/** The transcript chunk, destined for the live viewer. */
	forwardTranscript(message: SubagentTranscriptMessage): void {
		this.transcriptListener?.(message)
	}

	async run(): Promise<SubagentToolOutcome> {
		const { provider, parentTask, definition, request, runId, log } = this.options
		const isolation = request.isolation ?? definition.isolation ?? "none"
		let worktreePath: string | undefined
		let worktree: SubagentToolOutcome["worktree"]

		try {
			if (isolation === "worktree") {
				const candidate = path.join(os.tmpdir(), "zoo-subagent-worktrees", runId)
				worktreePath = await createSubagentWorktree({
					repoPath: parentTask.cwd,
					worktreePath: candidate,
					log,
				})
			}

			const context: SubagentTaskContext = {
				runId,
				groupId: this.options.groupId,
				definition,
				onToolUse: (toolName, params) => this.handleToolUse(toolName, params),
				onTranscriptMessage: (role, blocks) => {
					this.options.onTranscript?.({
						runId,
						groupId: this.options.groupId,
						seq: ++this.transcriptSeq,
						role,
						blocks,
					})
				},
				onAsk: (type) => this.answerAsk(type),
			}

			const task = new Task({
				provider,
				apiConfiguration: resolveModelConfiguration(
					parentTask.apiConfiguration,
					request.model ?? definition.model,
				),
				// A headless run must not create checkpoints for a workspace the
				// user is not looking at, and must not add itself to the task stack.
				enableCheckpoints: false,
				consecutiveMistakeLimit: parentTask.apiConfiguration.consecutiveMistakeLimit,
				toolRepetitionSoftLimit: parentTask.apiConfiguration.toolRepetitionSoftLimit,
				task: request.prompt,
				images: [],
				startTask: false,
				taskId: runId,
				initialStatus: "active",
				workspacePath: worktreePath ?? parentTask.cwd,
				parentTaskId: parentTask.taskId,
				subagent: context,
				maxTurns: this.options.maxTurns,
			})

			this.task = task

			if (this.cancelled) {
				await task.abortTask(true).catch(() => {})
			}

			try {
				await task.run()
			} catch (error) {
				log?.(`[subagent] ${runId} ended with an error: ${(error as Error).message}`)
			}

			const status = this.cancelled
				? "cancelled"
				: task.subagentStopRequested
					? "completed"
					: "failed"

			const error =
				status === "failed"
					? task.subagentPartial
						? `Reached maxTurns (${this.options.maxTurns}) without attempt_completion`
						: "The subagent stopped before calling attempt_completion"
					: undefined

			if (worktreePath) {
				worktree = await finalizeSubagentWorktree({
					repoPath: parentTask.cwd,
					worktreePath,
					log,
				})
			}

			const tokenUsage = task.getTokenUsage()
			const transcriptPath = await getTaskDirectoryPath(
				provider.context.globalStorageUri.fsPath,
				runId,
			).then((directory) => path.join(directory, "api_conversation_history.json"))

			return {
				runId,
				agentName: definition.name,
				status,
				summary: task.subagentSummary ?? "",
				error,
				partial: task.subagentPartial || undefined,
				filesRead: [...this.filesRead],
				filesModified: [...this.filesModified],
				durationMs: Date.now() - this.startedAt,
				toolCallCount: this.toolCallCount,
				tokenUsage: { input: tokenUsage.totalTokensIn ?? 0, output: tokenUsage.totalTokensOut ?? 0 },
				transcriptPath,
				worktree,
			}
		} catch (error) {
			if (worktreePath && !worktree) {
				worktree = await finalizeSubagentWorktree({
					repoPath: parentTask.cwd,
					worktreePath,
					log,
				}).catch(() => undefined)
			}

			return {
				runId,
				agentName: definition.name,
				status: this.cancelled ? "cancelled" : "failed",
				summary: this.task?.subagentSummary ?? "",
				error: error instanceof Error ? error.message : String(error),
				filesRead: [...this.filesRead],
				filesModified: [...this.filesModified],
				durationMs: Date.now() - this.startedAt,
				toolCallCount: this.toolCallCount,
				tokenUsage: { input: 0, output: 0 },
				worktree,
			}
		}
	}

	private handleToolUse(toolName: string, params: Record<string, unknown>): void {
		this.toolCallCount++
		const filePath = extractPath(params)

		if (filePath && READ_TOOLS.has(toolName)) {
			this.filesRead.add(filePath)
		}

		if (filePath && WRITE_TOOLS.has(toolName)) {
			this.filesModified.add(filePath)
		}

		this.lastAction = describeAction(toolName, params, filePath)

		this.activity.push({
			id: this.toolCallCount,
			tool: toolName,
			labelKey: SUBAGENT_ACTION_LABEL_KEYS[toolName],
			path: filePath,
			ts: Date.now(),
		})
		if (this.activity.length > MAX_ACTIVITY) {
			this.activity.splice(0, this.activity.length - MAX_ACTIVITY)
		}

		this.options.onProgress({
			currentAction: this.lastAction,
			activity: this.activity,
			toolCallCount: this.toolCallCount,
			filesRead: [...this.filesRead],
			filesModified: [...this.filesModified],
		})
	}

	/**
	 * Non-interactive policy: the run never waits on a human. Completion is
	 * accepted immediately and ends the child turn loop via
	 * `subagentStopRequested` in `Task#ask`.
	 */
	private answerAsk(type: ClineAsk): SubagentAskResult {
		if (type === "followup") {
			return {
				response: "messageResponse",
				text: "You cannot ask questions. Continue using your best assumption and state it in the final report.",
			}
		}

		return { response: "yesButtonClicked" }
	}
}

function describeAction(toolName: string, params: Record<string, unknown>, filePath?: string): string {
	switch (toolName) {
		case "read_file":
			return filePath ? `Reading ${filePath}` : "Reading a file"
		case "search_files":
			return typeof params.regex === "string" ? `Searching for ${params.regex}` : "Searching files"
		case "list_files":
			return filePath ? `Listing ${filePath}` : "Listing files"
		case "codebase_search":
			return typeof params.query === "string" ? `Searching the codebase for ${params.query}` : "Searching the codebase"
		case "execute_command":
			return typeof params.command === "string" ? `Running ${params.command}` : "Running a command"
		case "write_to_file":
			return filePath ? `Writing ${filePath}` : "Writing a file"
		case "apply_diff":
		case "edit":
		case "search_and_replace":
		case "edit_file":
		case "apply_patch":
			return filePath ? `Editing ${filePath}` : "Editing files"
		case "attempt_completion":
			return "Writing the final report"
		default:
			return `Using ${toolName}`
	}
}
