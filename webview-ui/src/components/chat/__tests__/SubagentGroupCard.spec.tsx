import { act, render, screen } from "@/utils/test-utils"
import type { SubagentRunSnapshot, SubagentUpdatePayload } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { SubagentActivityChip, SubagentGroupCard } from "../SubagentGroupCard"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// A tiny interpolation instead of the real i18n bundle keeps the assertions readable.
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key} ${Object.entries(options).map(([name, value]) => `${name}=${value}`).join(" ")}` : key,
	}),
}))

const makeRun = (overrides: Partial<SubagentRunSnapshot> & Pick<SubagentRunSnapshot, "runId">): SubagentRunSnapshot => ({
	parentTaskId: "task-1",
	toolUseId: `tool-${overrides.runId}`,
	groupId: "group",
	agentName: "explore",
	description: "",
	modelId: "test-model",
	status: "running",
	startedAt: 0,
	toolCallCount: 0,
	tokenUsage: { input: 0, output: 0 },
	filesRead: [],
	filesModified: [],
	...overrides,
})

const sendUpdate = (subagentUpdate: SubagentUpdatePayload) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "subagentUpdate", subagentUpdate } }))
	})

const postMessage = vi.mocked(vscode.postMessage)

describe("SubagentGroupCard", () => {
	beforeEach(() => {
		postMessage.mockClear()
	})

	it("shows every run it receives, with a count of the active ones", () => {
		render(
			<SubagentGroupCard
				groupId="initial"
				initialRuns={[
					makeRun({ runId: "run-a", groupId: "initial", description: "Map the auth module" }),
					makeRun({ runId: "run-b", groupId: "initial", description: "Review the diff" }),
				]}
			/>,
		)

		expect(screen.getByText("Map the auth module")).toBeInTheDocument()
		expect(screen.getByText("Review the diff")).toBeInTheDocument()

		const header = screen.getByText(/chat:subagents\.groupRunning/)
		expect(header.textContent).toContain("active=2")
		expect(header.textContent).toContain("total=2")
	})

	it("merges live updates by run id, keeps the announced order and appends new runs", () => {
		render(
			<SubagentGroupCard
				groupId="merge"
				initialRuns={[
					makeRun({ runId: "run-1", groupId: "merge", description: "First task" }),
					makeRun({ runId: "run-2", groupId: "merge", description: "Second task" }),
				]}
			/>,
		)

		expect(screen.getAllByText("chat:subagents.starting")).toHaveLength(2)

		sendUpdate({
			parentTaskId: "task-1",
			groupId: "merge",
			runs: [
				makeRun({
					runId: "run-1",
					groupId: "merge",
					description: "First task",
					status: "completed",
					durationMs: 1500,
					summary: "Found the token refresh path",
					toolCallCount: 4,
					filesRead: ["src/auth/jwt.ts"],
				}),
				makeRun({
					runId: "run-2",
					groupId: "merge",
					description: "Second task",
					status: "failed",
					error: "Provider refused the request",
				}),
				makeRun({ runId: "run-3", groupId: "merge", description: "Third task", status: "cancelled" }),
			],
		})

		const runs = screen.getAllByText(/task$/).map((element) => element.textContent)
		expect(runs).toEqual(["First task", "Second task", "Third task"])

		expect(screen.getByText("1.5s")).toBeInTheDocument()
		expect(screen.getByText("Found the token refresh path")).toBeInTheDocument()
		expect(screen.getByText("Provider refused the request")).toBeInTheDocument()
		expect(screen.getByText("chat:subagents.cancelled")).toBeInTheDocument()
		expect(screen.getByText(/chat:subagents\.metaTools count=4/)).toBeInTheDocument()

		const header = screen.getByText(/chat:subagents\.groupDoneWithFailures/)
		expect(header.textContent).toContain("completed=1")
		expect(header.textContent).toContain("failed=1")
		expect(header.textContent).toContain("total=3")
	})

	it("counts a cancelled run as finished in the header", () => {
		render(
			<SubagentGroupCard
				groupId="cancelled-header"
				initialRuns={[
					makeRun({ runId: "cancel-a", groupId: "cancelled-header", description: "Stopped task" }),
					makeRun({ runId: "cancel-b", groupId: "cancelled-header", description: "Done task" }),
				]}
			/>,
		)

		sendUpdate({
			parentTaskId: "task-1",
			groupId: "cancelled-header",
			runs: [
				makeRun({ runId: "cancel-a", groupId: "cancelled-header", description: "Stopped task", status: "cancelled" }),
				makeRun({ runId: "cancel-b", groupId: "cancelled-header", description: "Done task", status: "completed" }),
			],
		})

		const header = screen.getByText(/chat:subagents\.groupDone/)
		expect(header.textContent).toContain("completed=2")
		expect(header.textContent).toContain("total=2")
	})

	it("ignores updates that belong to another group", () => {
		render(
			<SubagentGroupCard
				groupId="own-group"
				initialRuns={[makeRun({ runId: "own-run", groupId: "own-group", description: "My run" })]}
			/>,
		)

		sendUpdate({
			parentTaskId: "task-1",
			groupId: "other-group",
			runs: [makeRun({ runId: "other-run", groupId: "other-group", description: "Someone else's run" })],
		})

		expect(screen.getByText("My run")).toBeInTheDocument()
		expect(screen.queryByText("Someone else's run")).not.toBeInTheDocument()
	})

	it("asks the extension to cancel an active run", () => {
		render(
			<SubagentGroupCard
				groupId="cancel-group"
				initialRuns={[makeRun({ runId: "cancel-me", groupId: "cancel-group", description: "Long task" })]}
			/>,
		)

		act(() => {
			screen.getByRole("button", { name: "chat:subagents.cancel" }).click()
		})

		expect(postMessage).toHaveBeenCalledWith({ type: "cancelSubagent", runId: "cancel-me" })
	})

	it("offers the transcript instead of cancel once a run is finished", () => {
		render(
			<SubagentGroupCard
				groupId="inspect-group"
				initialRuns={[
					makeRun({
						runId: "done-run",
						groupId: "inspect-group",
						description: "Finished task",
						status: "completed",
						durationMs: 900,
					}),
				]}
			/>,
		)

		act(() => {
			screen.getByRole("button", { name: "chat:subagents.inspect" }).click()
		})

		expect(postMessage).toHaveBeenCalledWith({
			type: "inspectSubagentTranscript",
			runId: "done-run",
			openInTab: true,
		})
	})

	it("keeps the in-chat live viewer button on a finished run for later review", () => {
		render(
			<SubagentGroupCard
				groupId="review-group"
				initialRuns={[
					makeRun({
						runId: "review-run",
						groupId: "review-group",
						description: "Finished task",
						status: "completed",
					}),
				]}
			/>,
		)

		act(() => {
			screen.getByRole("button", { name: "chat:subagents.viewLive" }).click()
		})

		// Opening the viewer asks the extension to subscribe and to send history,
		// even though the run is already finished.
		expect(postMessage).toHaveBeenCalledWith({ type: "setSubagentLiveViewer", runId: "review-run", open: true })
		expect(postMessage).toHaveBeenCalledWith({ type: "requestSubagentTranscript", runId: "review-run" })
	})
})

describe("SubagentActivityChip", () => {
	it("counts only the active runs of its own task", () => {
		const { container } = render(<SubagentActivityChip parentTaskId="task-1" />)

		expect(container).toBeEmptyDOMElement()

		sendUpdate({
			parentTaskId: "task-1",
			groupId: "chip-group",
			runs: [
				makeRun({ runId: "chip-1", groupId: "chip-group" }),
				makeRun({ runId: "chip-2", groupId: "chip-group" }),
				makeRun({ runId: "chip-3", groupId: "chip-group", status: "completed" }),
			],
		})
		expect(screen.getByText("2")).toBeInTheDocument()

		sendUpdate({
			parentTaskId: "another-task",
			groupId: "other-chip-group",
			runs: [makeRun({ runId: "other-chip", groupId: "other-chip-group" })],
		})
		expect(screen.getByText("2")).toBeInTheDocument()

		sendUpdate({
			parentTaskId: "task-1",
			groupId: "chip-group",
			runs: [
				makeRun({ runId: "chip-1", groupId: "chip-group", status: "completed" }),
				makeRun({ runId: "chip-2", groupId: "chip-group", status: "failed" }),
			],
		})
		expect(container).toBeEmptyDOMElement()
	})
})
