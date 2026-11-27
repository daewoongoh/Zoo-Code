/**
 * Operating contract appended to every subagent system prompt.
 *
 * Subagent prompts come from user-editable Markdown files, so the tool-use
 * contract lives here instead: the child must still end through
 * `attempt_completion`, must not wait for input, and must not try to delegate
 * again.
 */
export const SUBAGENT_TOOL_PROTOCOL = [
	"Tool protocol:",
	"- You are a headless subagent. No human will answer you. Never wait for a reply.",
	"- Use only the tools you are given. You cannot spawn subagents, delegate with new_task, switch modes or ask follow-up questions.",
	"- When the task is done, call attempt_completion with the final report as the result.",
	"- The report is the only thing your parent sees. State what you found or changed, exact file paths, what you verified, and any assumptions or open questions.",
].join("\n")
