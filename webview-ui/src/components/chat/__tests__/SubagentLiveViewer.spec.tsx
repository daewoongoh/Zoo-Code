import { act, render, screen } from "@/utils/test-utils"
import type { SubagentTranscriptMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { SubagentLiveViewer } from "../SubagentLiveViewer"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const postMessage = vi.mocked(vscode.postMessage)

const chunk = (overrides: Partial<SubagentTranscriptMessage> = {}): SubagentTranscriptMessage => ({
	runId: "run-1",
	groupId: "group-1",
	seq: 1,
	role: "assistant",
	blocks: [{ type: "text" as const, text: "hello from agent" }],
	...overrides,
})

const sendChunk = (m: SubagentTranscriptMessage) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "subagentTranscriptChunk", subagentTranscriptChunk: m } }))
	})

describe("SubagentLiveViewer", () => {
	beforeEach(() => {
		postMessage.mockClear()
	})

	it("subscribes and requests history when opened, unsubscribes when closed", () => {
		const { rerender } = render(
			<SubagentLiveViewer runId="run-1" title="My run" isOpen onClose={() => undefined} />,
		)

		expect(postMessage).toHaveBeenCalledWith({ type: "setSubagentLiveViewer", runId: "run-1", open: true })
		expect(postMessage).toHaveBeenCalledWith({ type: "requestSubagentTranscript", runId: "run-1" })

		rerender(<SubagentLiveViewer runId="run-1" title="My run" isOpen={false} onClose={() => undefined} />)

		expect(postMessage).toHaveBeenCalledWith({ type: "setSubagentLiveViewer", runId: "run-1", open: false })
	})

	it("appends live transcript chunks for its own run and dedupes by seq", () => {
		render(<SubagentLiveViewer runId="run-1" title="My run" isOpen onClose={() => undefined} />)

		sendChunk(chunk({ seq: 1 }))
		sendChunk(chunk({ seq: 2, blocks: [{ type: "text" as const, text: "second" }] }))
		sendChunk(chunk({ seq: 2, blocks: [{ type: "text" as const, text: "second" }] })) // duplicate
		sendChunk(chunk({ runId: "other", seq: 99, blocks: [{ type: "text" as const, text: "ignore me" }] }))

		expect(screen.getAllByText("hello from agent").length).toBeGreaterThanOrEqual(1)
		expect(screen.getByText("second")).toBeInTheDocument()
		expect(screen.queryByText("ignore me")).not.toBeInTheDocument()
	})

	it("renders reasoning, tool_use and tool_result blocks", () => {
		render(<SubagentLiveViewer runId="run-1" title="My run" isOpen onClose={() => undefined} />)

		sendChunk(
			chunk({
				seq: 5,
				blocks: [
					{ type: "reasoning" as const, text: "reflect" },
					{ type: "tool_use" as const, id: "t1", name: "read_file", input: "{}" },
					{ type: "tool_result" as const, id: "t1", content: "file contents" },
				],
			}),
		)

		expect(screen.getByText("chat:reasoning.thinking")).toBeInTheDocument()
		expect(screen.getByText("◆ read_file")).toBeInTheDocument()
		expect(screen.getByText("chat:subagents.result")).toBeInTheDocument()
		expect(screen.getByText("file contents")).toBeInTheDocument()
	})

	it("marks a finished run so its transcript can still be reviewed", () => {
		render(<SubagentLiveViewer runId="run-1" title="My run" isOpen ended onClose={() => undefined} />)

		expect(screen.getByText("chat:subagents.liveEnded")).toBeInTheDocument()

		// A finished run still fetches its buffered history when opened.
		sendChunk(chunk({ seq: 1 }))
		expect(screen.getByText("hello from agent")).toBeInTheDocument()
	})
})
