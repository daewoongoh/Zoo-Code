import { useEffect, useMemo, useRef } from "react"
import { BookOpen, Braces, CheckCircle2, FileEdit, FolderSearch, Search, Terminal } from "lucide-react"

import type { SubagentToolActivity } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

function actionIcon(tool: string) {
	switch (tool) {
		case "read_file":
			return <BookOpen className="size-3 shrink-0 text-vscode-charts-blue" />
		case "search_files":
			return <Search className="size-3 shrink-0 text-vscode-charts-blue" />
		case "list_files":
			return <FolderSearch className="size-3 shrink-0 text-vscode-charts-blue" />
		case "codebase_search":
			return <Braces className="size-3 shrink-0 text-vscode-charts-blue" />
		case "execute_command":
			return <Terminal className="size-3 shrink-0" />
		case "write_to_file":
		case "apply_diff":
		case "edit":
		case "search_and_replace":
		case "edit_file":
		case "apply_patch":
			return <FileEdit className="size-3 shrink-0 text-vscode-charts-orange" />
		case "attempt_completion":
			return <CheckCircle2 className="size-3 shrink-0 text-vscode-charts-green" />
		default:
			return <Braces className="size-3 shrink-0" />
	}
}

/**
 * Collapsible rolling log of a subagent's recent tool calls. Renders only the
 * structural activity (tool + short label + path), never tool output, so the
 * strict context-isolation contract holds.
 */
export const SubagentActivityFeed = ({ activity }: { activity: SubagentToolActivity[] }) => {
	const { t } = useAppTranslation()
	const scrollRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const el = scrollRef.current
		if (el) {
			el.scrollTop = el.scrollHeight
		}
	}, [activity.length])

	const rows = useMemo(
		() =>
			activity.map((a) => {
				const label = a.labelKey ? t(`chat:subagents.actions.${a.labelKey}`) : a.tool
				return { a, label }
			}),
		[activity, t],
	)

	if (activity.length === 0) {
		return <div className="text-vscode-descriptionForeground mt-1">{t("chat:subagents.noActivity")}</div>
	}

	return (
		<div
			ref={scrollRef}
			className="mt-1 max-h-32 overflow-y-auto rounded border border-vscode-panel-border bg-vscode-editorWidget-background/40 px-2 py-1">
			<ol className="space-y-1">
				{rows.map(({ a, label }) => (
					<li key={a.id} className="flex items-center gap-1.5 text-xs text-vscode-foreground/80 min-w-0">
						{actionIcon(a.tool)}
						<span className="truncate">
							<span className="font-medium">{label}</span>
							{a.path ? <span className="text-vscode-descriptionForeground"> · {a.path}</span> : null}
						</span>
					</li>
				))}
			</ol>
		</div>
	)
}
