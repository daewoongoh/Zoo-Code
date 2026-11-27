import { useCallback, useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Ban, ChevronDown, ChevronRight, FileSearch, Loader2, MonitorPlay } from "lucide-react"

import type { ExtensionMessage, SubagentRunSnapshot, SubagentStatus } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"

import { Button, StandardTooltip } from "@src/components/ui"
import { SubagentActivityFeed } from "./SubagentActivityFeed"
import { SubagentLiveViewer } from "./SubagentLiveViewer"

/**
 * Latest group snapshot for every group seen in this webview session.
 *
 * A card can mount after the extension already sent updates (for example when
 * the chat list virtualizes), so it recovers from this cache first and then
 * follows the live stream.
 */
const groupCache = new Map<string, SubagentRunSnapshot[]>()

function statusTone(status: SubagentStatus): string {
	switch (status) {
		case "completed":
			return "text-green-600"
		case "failed":
			return "text-red-600"
		case "cancelled":
			return "text-vscode-descriptionForeground"
		case "running":
			return "text-yellow-600"
		default:
			return "text-vscode-descriptionForeground"
	}
}

function isTerminal(status: SubagentStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled"
}

function mergeRuns(current: SubagentRunSnapshot[], next: SubagentRunSnapshot[]): SubagentRunSnapshot[] {
	const byId = new Map(current.map((run) => [run.runId, run]))
	for (const run of next) {
		byId.set(run.runId, { ...byId.get(run.runId), ...run })
	}

	// Preserve the order the runs were announced in; new runs append.
	const order = [...current.map((run) => run.runId)]
	for (const run of next) {
		if (!order.includes(run.runId)) {
			order.push(run.runId)
		}
	}

	return order.map((runId) => byId.get(runId)!).filter(Boolean)
}

export interface SubagentGroupCardProps {
	groupId: string
	initialRuns?: SubagentRunSnapshot[]
}

export const SubagentGroupCard = ({ groupId, initialRuns }: SubagentGroupCardProps) => {
	const { t } = useAppTranslation()
	const [runs, setRuns] = useState<SubagentRunSnapshot[]>(
		() => groupCache.get(groupId) ?? initialRuns ?? [],
	)

	useEffect(() => {
		if (initialRuns && initialRuns.length > 0) {
			setRuns((current) => {
				const merged = mergeRuns(current, initialRuns)
				groupCache.set(groupId, merged)
				return merged
			})
		}
	}, [groupId, initialRuns])

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type !== "subagentUpdate" || !message.subagentUpdate) {
				return
			}

			if (message.subagentUpdate.groupId !== groupId) {
				return
			}

			setRuns((current) => {
				const merged = mergeRuns(current, message.subagentUpdate!.runs)
				groupCache.set(groupId, merged)
				return merged
			})
		},
		[groupId],
	)

	useEvent("message", onMessage)

	const activeCount = runs.filter((run) => !isTerminal(run.status)).length
	const completedCount = runs.filter((run) => run.status === "completed").length
	const failedCount = runs.filter((run) => run.status === "failed").length
	const finishedCount = runs.filter((run) => isTerminal(run.status)).length

	const header = useMemo(() => {
		if (activeCount > 0) {
			return t("chat:subagents.groupRunning", { active: activeCount, total: runs.length })
		}

		// A cancelled run is finished but not completed; failures get their own
		// count so they never hide inside the total.
		if (failedCount > 0) {
			return t("chat:subagents.groupDoneWithFailures", {
				completed: completedCount,
				failed: failedCount,
				total: runs.length,
			})
		}

		return t("chat:subagents.groupDone", {
			completed: finishedCount,
			failed: failedCount,
			total: runs.length,
		})
	}, [activeCount, completedCount, failedCount, finishedCount, runs.length, t])

	if (runs.length === 0) {
		return null
	}

	return (
		<div className="border border-vscode-panel-border rounded-md overflow-hidden my-1">
			<div className="flex items-center gap-2 px-3 py-2 bg-vscode-editorWidget-background">
				{activeCount > 0 ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<FileSearch className="size-3.5" />
				)}
				<span className="text-xs font-medium">{header}</span>
			</div>
			<div className="divide-y divide-vscode-panel-border">
				{runs.map((run) => (
					<SubagentCard key={run.runId} run={run} />
				))}
			</div>
		</div>
	)
}

const SubagentCard = ({ run }: { run: SubagentRunSnapshot }) => {
	const { t } = useAppTranslation()
	const [expanded, setExpanded] = useState(false)
	const [liveOpen, setLiveOpen] = useState(false)
	const terminal = isTerminal(run.status)
	const duration = run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)}s` : undefined
	const meta = runMeta(run, t)
	const hasActivity = (run.activity?.length ?? 0) > 0

	return (
		<div className="px-3 py-2 text-xs">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className={cn("size-2 rounded-full shrink-0", statusDot(run.status))} />
						{hasActivity && (
							<Button
								variant="ghost"
								size="icon"
								className="size-4 p-0"
								onClick={() => setExpanded((v) => !v)}
								aria-label={t("chat:subagents.viewLive")}>
								{expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
							</Button>
						)}
						<span className="font-medium truncate">{run.description || run.agentName}</span>
						<span className="text-vscode-descriptionForeground shrink-0">{run.agentName}</span>
					</div>
					<div className="text-vscode-descriptionForeground mt-1 truncate">
						{run.status === "running" && (run.currentAction || t("chat:subagents.starting"))}
						{run.status === "queued" && t("chat:subagents.queued")}
						{run.status === "completed" && (duration ?? t("chat:subagents.completed"))}
						{run.status === "failed" && (run.error ?? t("chat:subagents.failed"))}
						{run.status === "cancelled" && t("chat:subagents.cancelled")}
					</div>
				</div>
				<div className="flex items-center gap-1 shrink-0">
					{run.partial && (
						<span className="text-yellow-600">{t("chat:subagents.partial")}</span>
					)}
					<StandardTooltip content={t("chat:subagents.viewLive")}>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							aria-label={t("chat:subagents.viewLive")}
							onClick={() => setLiveOpen(true)}>
							<MonitorPlay className="size-3" />
						</Button>
					</StandardTooltip>
					{!terminal && (
						<StandardTooltip content={t("chat:subagents.cancel")}>
							<Button
								variant="ghost"
								size="icon"
								className="size-6"
								aria-label={t("chat:subagents.cancel")}
								onClick={() => vscode.postMessage({ type: "cancelSubagent", runId: run.runId })}>
								<Ban className="size-3" />
							</Button>
						</StandardTooltip>
					)}
					{terminal && (
						<StandardTooltip content={t("chat:subagents.inspect")}>
							<Button
								variant="ghost"
								size="icon"
								className="size-6"
								aria-label={t("chat:subagents.inspect")}
								onClick={() =>
									vscode.postMessage({
										type: "inspectSubagentTranscript",
										runId: run.runId,
										openInTab: true,
									})
								}>
								<FileSearch className="size-3" />
							</Button>
						</StandardTooltip>
					)}
				</div>
			</div>

			{run.summary && (
				<div className="mt-1 text-vscode-foreground/80 line-clamp-2 whitespace-pre-wrap">{run.summary}</div>
			)}

			{meta && (
				<div className="mt-1 text-vscode-descriptionForeground flex flex-wrap gap-x-3">{meta}</div>
			)}

			{expanded && hasActivity && run.activity && <SubagentActivityFeed activity={run.activity} />}

			<SubagentLiveViewer
				runId={run.runId}
				title={run.description || run.agentName}
				isOpen={liveOpen}
				ended={terminal}
				onClose={() => setLiveOpen(false)}
			/>
		</div>
	)
}

function runMeta(run: SubagentRunSnapshot, t: ReturnType<typeof useAppTranslation>["t"]): string | null {
	const parts: string[] = []
	if (run.toolCallCount > 0) {
		parts.push(t("chat:subagents.metaTools", { count: run.toolCallCount }))
	}
	if (run.filesRead.length > 0) {
		parts.push(t("chat:subagents.metaRead", { count: run.filesRead.length }))
	}
	if (run.filesModified.length > 0) {
		parts.push(t("chat:subagents.metaWritten", { count: run.filesModified.length }))
	}
	if (run.worktree) {
		parts.push(t(run.worktree.kept ? "chat:subagents.worktreeKept" : "chat:subagents.worktreeRemoved"))
	}

	return parts.length > 0 ? parts.join(" · ") : null
}

function statusDot(status: SubagentStatus): string {
	switch (status) {
		case "completed":
			return "bg-green-600"
		case "failed":
			return "bg-red-600"
		case "cancelled":
			return "bg-vscode-descriptionForeground"
		case "running":
			return "bg-yellow-500 animate-pulse"
		default:
			return "bg-vscode-descriptionForeground"
	}
}

/**
 * Header chip that sums the non-terminal runs of the current task. It listens
 * to the same throttled update stream as the cards.
 */
export const SubagentActivityChip = ({ parentTaskId }: { parentTaskId?: string }) => {
	const { t } = useAppTranslation()
	const [active, setActive] = useState(0)

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type !== "subagentUpdate" || !message.subagentUpdate) {
				return
			}

			if (parentTaskId && message.subagentUpdate.parentTaskId !== parentTaskId) {
				return
			}

			const count = message.subagentUpdate.runs.filter((run) => !isTerminal(run.status)).length
			setActive(count)
		},
		[parentTaskId],
	)

	useEvent("message", onMessage)

	if (active === 0) {
		return null
	}

	return (
		<StandardTooltip content={t("chat:subagents.headerChip", { count: active })}>
			<div className={cn("flex items-center gap-1 text-xs", statusTone("running"))}>
				<Loader2 className="size-3 animate-spin" />
				<span>{active}</span>
			</div>
		</StandardTooltip>
	)
}
