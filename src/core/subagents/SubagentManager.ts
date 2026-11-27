import * as path from "path"
import * as fs from "fs/promises"

import {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_SUBAGENT_MAX_TURNS,
	MAX_CONCURRENT_SUBAGENTS,
	type SubagentDefinition,
	type SubagentRunSnapshot,
	type SubagentTranscriptMessage,
	type SubagentUpdatePayload,
} from "@roo-code/types"

import type { Task } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"
import { getTaskDirectoryPath } from "../../utils/storage"

import { SubagentRunner, type RunSubagentOptions } from "./SubagentRunner"
import type { SubagentSpawnRequest, SubagentToolOutcome } from "./types"

const UPDATE_THROTTLE_MS = 200

/** Upper bound on buffered live transcript messages kept per run. */
const MAX_TRANSCRIPT_BUFFER = 500

/** Minimal counting semaphore with FIFO release order. */
class Semaphore {
	private active = 0
	private readonly waiters: Array<() => void> = []

	constructor(private limit: number) {}

	setLimit(limit: number): void {
		this.limit = Math.max(1, limit)
		this.drain()
	}

	async acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active++
			return () => this.release()
		}

		await new Promise<void>((resolve) => this.waiters.push(resolve))
		return () => this.release()
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1)
		this.drain()
	}

	private drain(): void {
		while (this.active < this.limit && this.waiters.length > 0) {
			const next = this.waiters.shift()
			if (!next) {
				break
			}
			// Count the slot before waking the waiter, so this loop cannot
			// release more waiters than the limit allows.
			this.active++
			next()
		}
	}
}

interface RunRecord {
	snapshot: SubagentRunSnapshot
	runnerRef: { current?: SubagentRunner }
	promise: Promise<SubagentToolOutcome>
	/** Settles the promise the parent batch awaits. */
	resolve: (outcome: SubagentToolOutcome) => void
	parentTask: Task
}

interface GroupRecord {
	groupId: string
	parentTaskId: string
	startedAt: number
	completedAt?: number
	order: string[]
	runs: Map<string, RunRecord>
	emitTimer?: ReturnType<typeof setTimeout>
}

export interface SpawnSubagentParams {
	parentTask: Task
	definition: SubagentDefinition
	request: SubagentSpawnRequest
	runId: string
	groupId: string
	toolUseId: string
}

export interface SubagentManagerOptions {
	provider: ClineProvider
	log?: (message: string) => void
	/** Overrides runner creation. Tests use it to drive a run without an API. */
	createRunner?: (options: RunSubagentOptions) => SubagentRunner
}

/**
 * Owns every in-flight subagent run for one provider.
 *
 * Responsibilities: concurrency (a global semaphore plus a single writer
 * lock), live group snapshots (throttled `subagentUpdate` posts), cancellation,
 * and the final history metadata that links a transcript back to its parent
 * turn. It never posts the child as the active task.
 */
export class SubagentManager {
	private readonly groups = new Map<string, GroupRecord>()
	private readonly runToGroup = new Map<string, string>()
	private readonly concurrency = new Semaphore(DEFAULT_MAX_CONCURRENT_SUBAGENTS)
	private readonly writeLock = new Semaphore(1)
	/** Live transcript messages per run, bounded so buffers cannot grow unbounded. */
	private readonly transcriptBuffers = new Map<string, SubagentTranscriptMessage[]>()
	/** Runs whose live viewer is currently open; only these post chunks. */
	private readonly liveViewers = new Set<string>()
	private disposed = false

	constructor(private readonly options: SubagentManagerOptions) {}

	/** Opens or closes the live viewer for a run; closed viewers emit nothing. */
	setLiveViewer(runId: string, open: boolean): void {
		if (open) {
			this.liveViewers.add(runId)
		} else {
			this.liveViewers.delete(runId)
		}
	}

	/** The buffered transcript for a run that just opened its viewer. */
	requestTranscript(runId: string): SubagentTranscriptMessage[] {
		return this.transcriptBuffers.get(runId) ?? []
	}

	/** Drops buffers and viewer subscriptions for every run of a parent task. */
	clearStateForParent(parentTaskId: string): void {
		for (const group of this.groups.values()) {
			if (group.parentTaskId !== parentTaskId) {
				continue
			}
			for (const run of group.runs.values()) {
				this.liveViewers.delete(run.snapshot.runId)
				this.transcriptBuffers.delete(run.snapshot.runId)
			}
		}
	}

	private handleTranscript(message: SubagentTranscriptMessage): void {
		const buffer = (this.transcriptBuffers.get(message.runId) ?? []).concat(message)
		if (buffer.length > MAX_TRANSCRIPT_BUFFER) {
			buffer.splice(0, buffer.length - MAX_TRANSCRIPT_BUFFER)
		}
		this.transcriptBuffers.set(message.runId, buffer)

		if (!this.liveViewers.has(message.runId)) {
			return
		}

		void this.options.provider
			.postMessageToWebview({ type: "subagentTranscriptChunk", subagentTranscriptChunk: message })
			.catch(() => {
				// A closed webview drops live chunks silently.
			})
	}

	/**
	 * Starts a run and returns the promise the parent batch awaits. The call is
	 * synchronous on purpose: the presenter must keep dispatching sibling
	 * spawns while a slot is busy.
	 */
	spawn(params: SpawnSubagentParams): Promise<SubagentToolOutcome> {
		const { parentTask, definition, request, runId, groupId, toolUseId } = params
		const group = this.getOrCreateGroup(groupId, parentTask.taskId)
		const now = Date.now()

		const snapshot: SubagentRunSnapshot = {
			runId,
			parentTaskId: parentTask.taskId,
			toolUseId,
			groupId,
			agentName: definition.name,
			description: request.description,
			modelId: request.model ?? definition.model ?? "inherit",
			status: "queued",
			startedAt: now,
			toolCallCount: 0,
			tokenUsage: { input: 0, output: 0 },
			readonly: definition.readonly,
			isolation: request.isolation ?? definition.isolation ?? "none",
			filesRead: [],
			filesModified: [],
		}

		const runnerRef: { current?: SubagentRunner } = {}
		let resolveRun!: (outcome: SubagentToolOutcome) => void
		const promise = new Promise<SubagentToolOutcome>((resolve) => {
			resolveRun = resolve
		})

		const record: RunRecord = {
			snapshot,
			runnerRef,
			promise,
			resolve: resolveRun,
			parentTask,
		}

		group.order.push(runId)
		group.runs.set(runId, record)
		this.runToGroup.set(runId, groupId)
		this.scheduleEmit(group)

		// The record must exist before execution starts so a queued cancellation
		// can settle the promise without waiting for a concurrency slot.
		void this.execute({ params, group, snapshot, runnerRef }).then((outcome) => {
			record.resolve(outcome)
		})

		return promise
	}

	/** Cancels one run. A queued run resolves without starting. */
	cancel(runId: string): boolean {
		const groupId = this.runToGroup.get(runId)
		const group = groupId ? this.groups.get(groupId) : undefined
		const run = group?.runs.get(runId)

		if (!run || isTerminal(run.snapshot.status)) {
			return false
		}

		run.snapshot.status = "cancelled"
		run.snapshot.completedAt = Date.now()

		if (run.runnerRef.current) {
			run.runnerRef.current.requestCancel()
		} else {
			// Still queued behind a slot or the write lock: settle now instead of
			// making the parent batch wait for an unrelated run to release it.
			run.resolve(this.buildCancelledOutcome(run.snapshot, run.snapshot.runId, run.snapshot.agentName))
		}

		if (group) {
			this.scheduleEmit(group)
		}
		return true
	}

	/** Cancels every non-terminal run of a parent task, e.g. on task cancel. */
	cancelAllForParent(parentTaskId: string): void {
		for (const group of this.groups.values()) {
			if (group.parentTaskId !== parentTaskId) {
				continue
			}

			for (const run of [...group.runs.values()]) {
				this.cancel(run.snapshot.runId)
			}
		}
	}

	/**
	 * Settles a group after the parent turn has collected every spawn result.
	 * Called by `Task#runSubagentBatch`, which is the only point that knows all
	 * spawns of the turn are registered.
	 */
	async finalizeGroup(groupId: string): Promise<void> {
		const group = this.groups.get(groupId)
		if (group) {
			await this.completeGroupIfDone(group)
		}
	}

	/** Reads a finished run's transcript for the inspector. */
	async readTranscript(runId: string): Promise<string> {
		const directory = await getTaskDirectoryPath(this.options.provider.context.globalStorageUri.fsPath, runId)
		const file = path.join(directory, "api_conversation_history.json")
		return fs.readFile(file, "utf8")
	}

	dispose(): void {
		this.disposed = true
		this.liveViewers.clear()
		this.transcriptBuffers.clear()
		for (const group of this.groups.values()) {
			if (group.emitTimer) {
				clearTimeout(group.emitTimer)
				group.emitTimer = undefined
			}
			for (const run of group.runs.values()) {
				if (!isTerminal(run.snapshot.status)) {
					run.runnerRef.current?.requestCancel()
				}
			}
		}
		this.groups.clear()
		this.runToGroup.clear()
	}

	private getOrCreateGroup(groupId: string, parentTaskId: string): GroupRecord {
		const existing = this.groups.get(groupId)

		if (existing) {
			return existing
		}

		const group: GroupRecord = {
			groupId,
			parentTaskId,
			startedAt: Date.now(),
			order: [],
			runs: new Map(),
		}
		this.groups.set(groupId, group)
		return group
	}

	private async execute(context: {
		params: SpawnSubagentParams
		group: GroupRecord
		snapshot: SubagentRunSnapshot
		runnerRef: { current?: SubagentRunner }
	}): Promise<SubagentToolOutcome> {
		const { params, group, snapshot, runnerRef } = context
		const { parentTask, definition, request, runId } = params
		const log = this.options.log

		try {
			const state = await this.options.provider.getState({ includeTaskHistory: false })
			const limit = clampConcurrency(state.maxConcurrentSubagents)
			this.concurrency.setLimit(limit)

			const maxTurns = definition.maxTurns ?? state.defaultSubagentMaxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS

			const releaseSlot = await this.concurrency.acquire()
			let releaseWrite: (() => void) | undefined
			const cancelled = () => this.disposed || snapshot.status === "cancelled"

			try {
				if (cancelled()) {
					return this.finishCancelled(params)
				}

				const needsWriteLock = definition.readonly !== true && snapshot.isolation !== "worktree"
				if (needsWriteLock) {
					releaseWrite = await this.writeLock.acquire()
				}

				if (cancelled()) {
					return this.finishCancelled(params)
				}

				snapshot.status = "running"
				snapshot.startedAt = Date.now()
				this.scheduleEmit(group)

				const runnerOptions: RunSubagentOptions = {
					provider: this.options.provider,
					parentTask,
					definition,
					request,
					runId,
					groupId: group.groupId,
					toolUseId: snapshot.toolUseId,
					maxTurns,
					log,
					onProgress: (patch) => {
						Object.assign(snapshot, patch)
						this.scheduleEmit(group)
					},
					onTranscript: (message) => this.handleTranscript(message),
				}
				const runner = this.options.createRunner
					? this.options.createRunner(runnerOptions)
					: new SubagentRunner(runnerOptions)

				const record = group.runs.get(runId)
				if (record) {
					record.runnerRef.current = runner
				}
				runnerRef.current = runner

				const outcome = await runner.run()
				this.applyOutcome(snapshot, outcome)
				return outcome
			} finally {
				releaseWrite?.()
				releaseSlot()
			}
		} catch (error) {
			const outcome: SubagentToolOutcome = {
				runId,
				agentName: definition.name,
				status: "failed",
				summary: "",
				error: error instanceof Error ? error.message : String(error),
				filesRead: [],
				filesModified: [],
				toolCallCount: 0,
				tokenUsage: { input: 0, output: 0 },
			}
			this.applyOutcome(snapshot, outcome)
			return outcome
		}
	}

	private finishCancelled(params: SpawnSubagentParams): SubagentToolOutcome {
		const snapshot = this.groups.get(params.groupId)?.runs.get(params.runId)?.snapshot
		const outcome = this.buildCancelledOutcome(snapshot, params.runId, params.definition.name)
		this.applyOutcome(snapshot, outcome)
		return outcome
	}

	private buildCancelledOutcome(
		snapshot: SubagentRunSnapshot | undefined,
		runId: string,
		agentName: string,
	): SubagentToolOutcome {
		return {
			runId: snapshot?.runId ?? runId,
			agentName: snapshot?.agentName ?? agentName,
			status: "cancelled",
			summary: "",
			error: "Cancelled before the run started",
			filesRead: snapshot?.filesRead ?? [],
			filesModified: snapshot?.filesModified ?? [],
			toolCallCount: snapshot?.toolCallCount ?? 0,
			tokenUsage: snapshot?.tokenUsage ?? { input: 0, output: 0 },
		}
	}

	private applyOutcome(snapshot: SubagentRunSnapshot | undefined, outcome: SubagentToolOutcome): void {
		if (!snapshot) {
			return
		}

		snapshot.status = outcome.status
		snapshot.completedAt = Date.now()
		snapshot.durationMs = outcome.durationMs
		snapshot.summary = outcome.summary || undefined
		snapshot.error = outcome.error
		snapshot.partial = outcome.partial
		snapshot.filesRead = outcome.filesRead
		snapshot.filesModified = outcome.filesModified
		snapshot.toolCallCount = outcome.toolCallCount
		snapshot.tokenUsage = outcome.tokenUsage
		snapshot.worktree = outcome.worktree

		const groupId = this.runToGroup.get(outcome.runId)
		const group = groupId ? this.groups.get(groupId) : undefined
		if (group) {
			this.scheduleEmit(group)
		}
	}

	private async completeGroupIfDone(group: GroupRecord): Promise<void> {
		if (this.disposed || group.completedAt) {
			return
		}

		const runs = group.order
			.map((runId) => group.runs.get(runId)?.snapshot)
			.filter((snapshot): snapshot is SubagentRunSnapshot => !!snapshot)

		if (runs.length === 0 || runs.some((snapshot) => !isTerminal(snapshot.status))) {
			return
		}

		group.completedAt = Date.now()
		this.scheduleEmit(group)

		const parentTask = group.runs.get(group.order[0])?.parentTask
		if (parentTask) {
			// Persist the final group on the leader row so a reloaded chat can
			// render the card without the live stream.
			await parentTask.updateSubagentGroupMessage(group.groupId, runs).catch(() => {})
		}

		this.persistHistoryMeta(group, runs)
	}

	private persistHistoryMeta(group: GroupRecord, runs: SubagentRunSnapshot[]): void {
		// Never inside a group/slot lock: the history store has its own lock and
		// `atomicReadAndUpdate` is not reentrant.
		for (const snapshot of runs) {
			void this.options.provider.taskHistoryStore
				.atomicReadAndUpdate(snapshot.runId, (item) => ({
					...item,
					subagent: {
						runId: snapshot.runId,
						groupId: group.groupId,
						parentTaskId: group.parentTaskId,
						agentName: snapshot.agentName,
						status: snapshot.status,
						partial: snapshot.partial,
					},
				}))
				.catch(() => {
					// The transcript write already owns durability; a missing
					// history row must not fail the run.
				})
		}
	}

	private scheduleEmit(group: GroupRecord): void {
		if (this.disposed || group.emitTimer) {
			return
		}

		group.emitTimer = setTimeout(() => {
			group.emitTimer = undefined
			this.emit(group)
		}, UPDATE_THROTTLE_MS)
	}

	private emit(group: GroupRecord): void {
		const runs = group.order
			.map((runId) => group.runs.get(runId)?.snapshot)
			.filter((snapshot): snapshot is SubagentRunSnapshot => !!snapshot)

		const payload: SubagentUpdatePayload = {
			parentTaskId: group.parentTaskId,
			groupId: group.groupId,
			runs,
		}

		void this.options.provider
			.postMessageToWebview({ type: "subagentUpdate", subagentUpdate: payload })
			.catch(() => {
				// A closed webview is not an error for a headless run.
			})
	}
}

function isTerminal(status: SubagentRunSnapshot["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled"
}

function clampConcurrency(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_MAX_CONCURRENT_SUBAGENTS
	}

	return Math.min(MAX_CONCURRENT_SUBAGENTS, Math.max(1, Math.round(value)))
}
