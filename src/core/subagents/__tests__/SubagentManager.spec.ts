// npx vitest run core/subagents/__tests__/SubagentManager.spec.ts

import type { SubagentDefinition } from "@roo-code/types"

import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../../webview/ClineProvider"
import { SubagentManager } from "../SubagentManager"
import type { RunSubagentOptions, SubagentRunner } from "../SubagentRunner"
import type { SubagentSpawnRequest, SubagentToolOutcome } from "../types"

interface FakeRun {
	options: RunSubagentOptions
	cancelCount: number
	promise: Promise<SubagentToolOutcome>
	resolve: (outcome: SubagentToolOutcome) => void
	reject: (error: Error) => void
}

function makeRunnerFactory() {
	const runs: FakeRun[] = []

	const createRunner = (options: RunSubagentOptions): SubagentRunner => {
		let resolveRun!: (outcome: SubagentToolOutcome) => void
		let rejectRun!: (error: Error) => void
		const promise = new Promise<SubagentToolOutcome>((resolve, reject) => {
			resolveRun = resolve
			rejectRun = reject
		})

		const run: FakeRun = { options, cancelCount: 0, promise, resolve: resolveRun, reject: rejectRun }
		runs.push(run)

		// The manager only calls these two members on a runner.
		return {
			requestCancel: () => {
				run.cancelCount++
			},
			run: () => promise,
		} as unknown as SubagentRunner
	}

	return { runs, createRunner }
}

function makeProvider(state: Record<string, unknown> = {}) {
	return {
		context: makeExtensionContext({ globalStorageUri: makeUri("/mock/global-storage") }),
		log: vi.fn(),
		getState: vi.fn(async () => ({ maxConcurrentSubagents: 2, defaultSubagentMaxTurns: 5, ...state })),
		postMessageToWebview: vi.fn(async (_message: unknown) => undefined),
		taskHistoryStore: { atomicReadAndUpdate: vi.fn(async () => undefined) },
	}
}

function makeParentTask() {
	return {
		taskId: "parent-1",
		cwd: "/workspace",
		updateSubagentGroupMessage: vi.fn(async () => undefined),
	}
}

const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
	name: "explore",
	description: "Explores",
	systemPrompt: "Explore.",
	source: "builtin",
	readonly: true,
	...overrides,
})

const outcome = (
	runId: string,
	overrides: Partial<SubagentToolOutcome> = {},
): SubagentToolOutcome => ({
	runId,
	agentName: "explore",
	status: "completed",
	summary: `${runId} summary`,
	filesRead: [],
	filesModified: [],
	toolCallCount: 0,
	tokenUsage: { input: 0, output: 0 },
	...overrides,
})

async function flush(times = 4): Promise<void> {
	for (let index = 0; index < times; index++) {
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

describe("SubagentManager", () => {
	let provider: ReturnType<typeof makeProvider>
	let parentTask: ReturnType<typeof makeParentTask>
	let factory: ReturnType<typeof makeRunnerFactory>
	let manager: SubagentManager
	let runCounter: number

	const spawn = (
		overrides: {
			definition?: SubagentDefinition
			runId?: string
			groupId?: string
			request?: Partial<SubagentSpawnRequest>
		} = {},
	) => {
		const runId = overrides.runId ?? `run-${++runCounter}`

		return manager.spawn({
			parentTask: parentTask as unknown as Task,
			definition: overrides.definition ?? definition(),
			request: { agent: "explore", description: runId, prompt: "Investigate", ...overrides.request },
			runId,
			groupId: overrides.groupId ?? "group-1",
			toolUseId: runId,
		})
	}

	const createManager = (state: Record<string, unknown> = {}) => {
		provider = makeProvider(state)
		factory = makeRunnerFactory()
		manager = new SubagentManager({
			provider: provider as unknown as ClineProvider,
			createRunner: factory.createRunner,
		})
	}

	beforeEach(() => {
		runCounter = 0
		parentTask = makeParentTask()
		createManager()
	})

	afterEach(() => {
		manager.dispose()
	})

	it("starts readonly runs in parallel up to the concurrency limit", async () => {
		const first = spawn()
		const second = spawn()

		await flush()

		expect(factory.runs).toHaveLength(2)
		factory.runs[0].resolve(outcome("run-1"))
		factory.runs[1].resolve(outcome("run-2"))

		await expect(Promise.all([first, second])).resolves.toEqual([
			expect.objectContaining({ runId: "run-1", status: "completed" }),
			expect.objectContaining({ runId: "run-2", status: "completed" }),
		])
	})

	it("queues runs beyond the configured limit", async () => {
		createManager({ maxConcurrentSubagents: 2 })

		const first = spawn()
		spawn()
		const third = spawn()

		await flush()
		expect(factory.runs).toHaveLength(2)

		factory.runs[0].resolve(outcome("run-1"))
		await first
		await flush()

		expect(factory.runs).toHaveLength(3)
		factory.runs[1].resolve(outcome("run-2"))
		factory.runs[2].resolve(outcome("run-3"))
		await third
	})

	it("releases only one queued run per freed slot", async () => {
		createManager({ maxConcurrentSubagents: 1 })

		const runs = [spawn(), spawn(), spawn(), spawn()]
		await flush()
		expect(factory.runs).toHaveLength(1)

		factory.runs[0].resolve(outcome("run-1"))
		await runs[0]
		await flush()
		expect(factory.runs).toHaveLength(2)

		factory.runs[1].resolve(outcome("run-2"))
		await runs[1]
		await flush()
		expect(factory.runs).toHaveLength(3)

		factory.runs[2].resolve(outcome("run-3"))
		await runs[2]
		factory.runs[3].resolve(outcome("run-4"))
		await runs[3]
	})

	it("serializes writers behind a single write lock", async () => {
		const writer = definition({ name: "general", readonly: false })

		const first = spawn({ definition: writer })
		spawn({ definition: writer })

		await flush()
		expect(factory.runs).toHaveLength(1)

		factory.runs[0].resolve(outcome("run-1"))
		await first
		await flush()

		expect(factory.runs).toHaveLength(2)
		factory.runs[1].resolve(outcome("run-2"))
	})

	it("settles a cancelled queued run without waiting for a slot", async () => {
		createManager({ maxConcurrentSubagents: 1 })

		const first = spawn()
		const queued = spawn()

		await flush()
		expect(factory.runs).toHaveLength(1)

		expect(manager.cancel("run-2")).toBe(true)
		await expect(queued).resolves.toMatchObject({ runId: "run-2", status: "cancelled" })
		expect(factory.runs).toHaveLength(1)

		manager.cancel("run-1")
		factory.runs[0].resolve(outcome("run-1", { status: "cancelled" }))
		await first
	})

	it("cancels a running run through its runner", async () => {
		const running = spawn()
		await flush()

		expect(manager.cancel("run-1")).toBe(true)
		expect(factory.runs[0].cancelCount).toBe(1)

		factory.runs[0].resolve(outcome("run-1", { status: "cancelled" }))
		await expect(running).resolves.toMatchObject({ status: "cancelled" })
	})

	it("cancels every run of the parent task", async () => {
		createManager({ maxConcurrentSubagents: 1 })

		const running = spawn()
		const queued = spawn()
		await flush()

		manager.cancelAllForParent("parent-1")

		expect(factory.runs[0].cancelCount).toBe(1)
		await expect(queued).resolves.toMatchObject({ status: "cancelled" })

		factory.runs[0].resolve(outcome("run-1", { status: "cancelled" }))
		await running
	})

	it("finalizes the group once, writes the leader row and links history metadata", async () => {
		const first = spawn()
		const second = spawn()
		await flush()

		factory.runs[0].resolve(outcome("run-1"))
		factory.runs[1].resolve(outcome("run-2", { status: "failed", error: "boom" }))
		await Promise.all([first, second])

		await manager.finalizeGroup("group-1")
		await flush()

		expect(parentTask.updateSubagentGroupMessage).toHaveBeenCalledTimes(1)
		expect(parentTask.updateSubagentGroupMessage).toHaveBeenCalledWith(
			"group-1",
			[
				expect.objectContaining({ runId: "run-1", status: "completed" }),
				expect.objectContaining({ runId: "run-2", status: "failed" }),
			],
		)

		expect(provider.taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(2)
		expect(provider.taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledWith(
			"run-1",
			expect.any(Function),
		)

		await manager.finalizeGroup("group-1")
		expect(parentTask.updateSubagentGroupMessage).toHaveBeenCalledTimes(1)
	})

	it("does not finalize a group while a run is still active", async () => {
		const first = spawn()
		await flush()

		await manager.finalizeGroup("group-1")
		expect(parentTask.updateSubagentGroupMessage).not.toHaveBeenCalled()

		factory.runs[0].resolve(outcome("run-1"))
		await first
	})

	it("uses the definition maxTurns over the setting and falls back to the setting", async () => {
		createManager({ defaultSubagentMaxTurns: 9 })

		spawn({ definition: definition({ maxTurns: 3 }) })
		spawn()
		await flush()

		expect(factory.runs[0].options.maxTurns).toBe(3)
		expect(factory.runs[1].options.maxTurns).toBe(9)
	})

	it("emits only subagentUpdate messages and never posts task state", async () => {
		const run = spawn()
		await flush()
		factory.runs[0].resolve(outcome("run-1"))
		await run

		await vi.waitFor(() => expect(provider.postMessageToWebview).toHaveBeenCalled())

		for (const call of provider.postMessageToWebview.mock.calls) {
			expect(call[0]).toMatchObject({ type: "subagentUpdate" })
		}
	})

	it("cancels active runs on dispose", async () => {
		const run = spawn()
		await flush()

		manager.dispose()

		expect(factory.runs[0].cancelCount).toBe(1)
		factory.runs[0].resolve(outcome("run-1", { status: "cancelled" }))
		await run
	})

	it("buffers transcript chunks and posts them only while the live viewer is open", async () => {
		const run = spawn({ runId: "run-live" })
		await flush()

		const { onTranscript } = factory.runs[0].options
		expect(onTranscript).toBeDefined()

		const msg = {
			runId: "run-live",
			groupId: "group-1",
			seq: 1,
			role: "assistant" as const,
			blocks: [{ type: "text" as const, text: "thinking out loud" }],
		}

		// Viewer closed: buffered but not posted.
		manager.setLiveViewer("run-live", false)
		onTranscript!(msg)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		expect(manager.requestTranscript("run-live")).toEqual([msg])

		// Viewer open: live chunks stream to the webview.
		manager.setLiveViewer("run-live", true)
		onTranscript!(msg)
		const liveCalls = provider.postMessageToWebview.mock.calls.filter(
			(call) => (call[0] as { type?: string })?.type === "subagentTranscriptChunk",
		)
		expect(liveCalls.length).toBe(1)
		expect(liveCalls[0][0]).toMatchObject({ type: "subagentTranscriptChunk", subagentTranscriptChunk: msg })

		factory.runs[0].resolve(outcome("run-live"))
		await run
	})

	it("clears buffers and viewers for a parent task on delete", async () => {
		const run = spawn({ runId: "run-del" })
		await flush()
		const { onTranscript } = factory.runs[0].options

		const msg = {
			runId: "run-del",
			groupId: "group-1",
			seq: 1,
			role: "assistant" as const,
			blocks: [{ type: "text" as const, text: "hi" }],
		}

		manager.setLiveViewer("run-del", true)
		onTranscript!(msg)
		expect(manager.requestTranscript("run-del")).toHaveLength(1)

		manager.clearStateForParent("parent-1")

		// The buffer and viewer subscription for the deleted parent are removed.
		expect(manager.requestTranscript("run-del")).toHaveLength(0)

		provider.postMessageToWebview.mockClear()
		onTranscript!(msg) // re-buffers, but the (now-closed) viewer must not post
		const liveCalls = provider.postMessageToWebview.mock.calls.filter(
			(call) => (call[0] as { type?: string })?.type === "subagentTranscriptChunk",
		)
		expect(liveCalls).toHaveLength(0)

		factory.runs[0].resolve(outcome("run-del"))
		await run
	})
})
