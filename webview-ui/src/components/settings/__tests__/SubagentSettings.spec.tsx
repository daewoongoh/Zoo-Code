import React from "react"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { SubagentSettings } from "../SubagentSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// The toolkit checkbox is a custom element; a native input makes the click path visible to jsdom.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		onChange,
		children,
	}: {
		checked?: boolean
		onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
		children?: React.ReactNode
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))

// Radix needs pointer events; a range input exercises the same value/onValueChange contract.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	Slider: ({
		value,
		onValueChange,
		"data-testid": testId,
	}: {
		value?: number[]
		onValueChange?: (value: number[]) => void
		"data-testid"?: string
	}) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			onChange={(event) => onValueChange?.([Number(event.target.value)])}
			data-testid={testId}
		/>
	),
}))

const renderSettings = (overrides: Partial<React.ComponentProps<typeof SubagentSettings>> = {}) => {
	const setCachedStateField = vi.fn()

	render(
		<SubagentSettings
			subagentsEnabled={false}
			maxConcurrentSubagents={4}
			defaultSubagentMaxTurns={15}
			setCachedStateField={setCachedStateField}
			{...overrides}
		/>,
	)

	return { setCachedStateField }
}

describe("SubagentSettings", () => {
	it("shows the saved settings", () => {
		renderSettings({ subagentsEnabled: true, maxConcurrentSubagents: 6, defaultSubagentMaxTurns: 30 })

		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByTestId("subagent-concurrency-slider")).toHaveValue("6")
		expect(screen.getByTestId("subagent-max-turns-slider")).toHaveValue("30")
	})

	it("writes each edit to the cached state instead of saving immediately", () => {
		const { setCachedStateField } = renderSettings()

		fireEvent.click(screen.getByRole("checkbox"))
		expect(setCachedStateField).toHaveBeenCalledWith("subagentsEnabled", true)

		fireEvent.change(screen.getByTestId("subagent-concurrency-slider"), { target: { value: "7" } })
		expect(setCachedStateField).toHaveBeenCalledWith("maxConcurrentSubagents", 7)

		fireEvent.change(screen.getByTestId("subagent-max-turns-slider"), { target: { value: "22" } })
		expect(setCachedStateField).toHaveBeenCalledWith("defaultSubagentMaxTurns", 22)
	})

	it("falls back to the documented defaults when a setting is unset", () => {
		renderSettings({
			subagentsEnabled: undefined,
			maxConcurrentSubagents: undefined,
			defaultSubagentMaxTurns: undefined,
		})

		expect(screen.getByRole("checkbox")).not.toBeChecked()
		expect(screen.getByTestId("subagent-concurrency-slider")).toHaveValue("4")
		expect(screen.getByTestId("subagent-max-turns-slider")).toHaveValue("15")
	})
})
