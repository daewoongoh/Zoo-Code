import { HTMLAttributes } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import {
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_SUBAGENT_MAX_TURNS,
	MAX_CONCURRENT_SUBAGENTS,
	MAX_SUBAGENT_MAX_TURNS,
	MIN_CONCURRENT_SUBAGENTS,
} from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { Slider } from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type SubagentSettingsProps = HTMLAttributes<HTMLDivElement> & {
	subagentsEnabled?: boolean
	maxConcurrentSubagents?: number
	defaultSubagentMaxTurns?: number
	setCachedStateField: SetCachedStateField<
		"subagentsEnabled" | "maxConcurrentSubagents" | "defaultSubagentMaxTurns"
	>
}

export const SubagentSettings = ({
	subagentsEnabled,
	maxConcurrentSubagents,
	defaultSubagentMaxTurns,
	setCachedStateField,
	...props
}: SubagentSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.subagents")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="subagents-enable"
					section="subagents"
					label={t("settings:subagents.enable.label")}>
					<VSCodeCheckbox
						checked={subagentsEnabled ?? false}
						onChange={(e) => {
							setCachedStateField("subagentsEnabled", (e.target as HTMLInputElement).checked)
						}}>
						<span className="font-medium">{t("settings:subagents.enable.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:subagents.enable.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="subagents-concurrency"
					section="subagents"
					label={t("settings:subagents.concurrency.label")}
					className="mt-4">
					<label className="block text-sm font-medium mb-2">{t("settings:subagents.concurrency.label")}</label>
					<div className="flex items-center gap-2">
						<Slider
							min={MIN_CONCURRENT_SUBAGENTS}
							max={MAX_CONCURRENT_SUBAGENTS}
							step={1}
							value={[maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS]}
							onValueChange={([value]) => {
								setCachedStateField("maxConcurrentSubagents", value)
							}}
							className="flex-1"
							data-testid="subagent-concurrency-slider"
						/>
						<span className="w-12 text-center">
							{maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS}
						</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:subagents.concurrency.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="subagents-max-turns"
					section="subagents"
					label={t("settings:subagents.maxTurns.label")}
					className="mt-4">
					<label className="block text-sm font-medium mb-2">{t("settings:subagents.maxTurns.label")}</label>
					<div className="flex items-center gap-2">
						<Slider
							min={1}
							max={MAX_SUBAGENT_MAX_TURNS}
							step={1}
							value={[defaultSubagentMaxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS]}
							onValueChange={([value]) => {
								setCachedStateField("defaultSubagentMaxTurns", value)
							}}
							className="flex-1"
							data-testid="subagent-max-turns-slider"
						/>
						<span className="w-12 text-center">
							{defaultSubagentMaxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS}
						</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:subagents.maxTurns.description")}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
