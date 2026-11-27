import { render, screen } from "@/utils/test-utils"
import type { SubagentToolActivity } from "@roo-code/types"

import { SubagentActivityFeed } from "../SubagentActivityFeed"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const activity = (overrides: Partial<SubagentToolActivity> = {}): SubagentToolActivity => ({
	id: 1,
	tool: "read_file",
	labelKey: "readfile",
	ts: 0,
	path: "/src/a.ts",
	...overrides,
})

describe("SubagentActivityFeed", () => {
	it("renders a localized row per activity with its path", () => {
		render(
			<SubagentActivityFeed
				activity={[
					activity({ id: 1, tool: "read_file", labelKey: "readfile", path: "/src/a.ts" }),
					activity({ id: 2, tool: "execute_command", labelKey: "executecommand", path: undefined }),
				]}
			/>,
		)

		expect(screen.getByText("chat:subagents.actions.readfile")).toBeInTheDocument()
		expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument()
		expect(screen.getByText("chat:subagents.actions.executecommand")).toBeInTheDocument()
	})

	it("falls back to the raw tool name when no label key exists", () => {
		render(<SubagentActivityFeed activity={[activity({ labelKey: undefined, tool: "some_tool" })]} />)
		expect(screen.getByText("some_tool")).toBeInTheDocument()
	})

	it("shows the empty state when there is no activity", () => {
		render(<SubagentActivityFeed activity={[]} />)
		expect(screen.getByText("chat:subagents.noActivity")).toBeInTheDocument()
	})
})
