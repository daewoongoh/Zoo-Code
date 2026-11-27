import type { SubagentToolOutcome } from "./types"

/**
 * Formats the single `tool_result` the parent receives for a subagent run.
 * Deliberately compact: the child's transcript stays on disk.
 */
export function formatSubagentOutcome(outcome: SubagentToolOutcome): string {
	const lines: string[] = []

	lines.push(`Subagent "${outcome.agentName}" ${outcome.status}${outcome.partial ? " (partial: max turns reached)" : ""}.`)

	if (outcome.durationMs !== undefined) {
		lines.push(
			`Duration ${(outcome.durationMs / 1000).toFixed(1)}s · tools ${outcome.toolCallCount} · tokens in ${outcome.tokenUsage.input} / out ${outcome.tokenUsage.output}`,
		)
	}

	if (outcome.filesRead.length > 0) {
		lines.push(`Files read: ${outcome.filesRead.join(", ")}`)
	}

	if (outcome.filesModified.length > 0) {
		lines.push(`Files modified: ${outcome.filesModified.join(", ")}`)
	}

	if (outcome.worktree) {
		lines.push(
			`Worktree ${outcome.worktree.kept ? "kept" : "removed"}: ${outcome.worktree.path}${
				outcome.worktree.filesChanged !== undefined ? ` (${outcome.worktree.filesChanged} files changed)` : ""
			}`,
		)
		if (outcome.worktree.diffStat) {
			lines.push(`Diff stat:\n${outcome.worktree.diffStat}`)
		}
	}

	if (outcome.error) {
		lines.push(`Error: ${outcome.error}`)
	}

	if (outcome.summary.trim()) {
		lines.push("", "Summary:", outcome.summary.trim())
	}

	if (outcome.transcriptPath) {
		lines.push("", `Full transcript: ${outcome.transcriptPath}`)
	}

	return lines.join("\n")
}
