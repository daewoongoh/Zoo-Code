import { useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import { Bot, ChevronDown, ChevronUp, Lightbulb, SquareTerminal, User } from "lucide-react"

import type { ExtensionMessage, SubagentTranscriptMessage, SubagentTranscriptBlock } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Modal } from "@src/components/common/Modal"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"

import { Markdown } from "./Markdown"
import { ToolUseBlock, ToolUseBlockHeader } from "../common/ToolUseBlock"

/** Only this many transcript messages are rendered; earlier ones load on demand. */
const INITIAL_WINDOW = 200
const LOAD_STEP = 200

/** Matches the chat message header (icon + bold label + indented content). */
const HEADER_STYLE: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "10px",
	cursor: "default",
	marginBottom: "8px",
	wordBreak: "break-word",
}

interface SubagentLiveViewerProps {
	runId: string
	title: string
	isOpen: boolean
	/** True when the run already reached a terminal state; the transcript is static. */
	ended?: boolean
	onClose: () => void
}

/**
 * Dedicated, read-only live transcript viewer for one subagent run. It renders
 * the child conversation in the same visual language as the chat (message
 * headers, collapsible reasoning, tool blocks, user bubbles) so it reads like a
 * chat. It lives inside the chat webview but is a separate diagnostic surface:
 * nothing here is ever mixed into the parent conversation message list. It
 * stays open after the run completes so the transcript can be reviewed.
 */
export const SubagentLiveViewer = ({ runId, title, isOpen, ended = false, onClose }: SubagentLiveViewerProps) => {
	const { t } = useAppTranslation()
	const [messages, setMessages] = useState<SubagentTranscriptMessage[]>([])
	const [windowStart, setWindowStart] = useState(0)
	const scrollRef = useRef<HTMLDivElement>(null)
	const followRef = useRef(true)

	useEffect(() => {
		if (!isOpen || !runId) {
			return
		}
		setMessages([])
		setWindowStart(0)
		followRef.current = true

		vscode.postMessage({ type: "setSubagentLiveViewer", runId, open: true })
		vscode.postMessage({ type: "requestSubagentTranscript", runId })

		return () => {
			vscode.postMessage({ type: "setSubagentLiveViewer", runId, open: false })
		}
	}, [isOpen, runId])

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "subagentTranscriptChunk" || !message.subagentTranscriptChunk) {
				return
			}
			if (message.subagentTranscriptChunk.runId !== runId) {
				return
			}
			const chunk = message.subagentTranscriptChunk
			setMessages((prev) => {
				if (prev.some((m) => m.seq === chunk.seq)) {
					return prev
				}
				return [...prev, chunk].sort((a, b) => a.seq - b.seq)
			})
		},
		[runId],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		const el = scrollRef.current
		if (el && followRef.current) {
			el.scrollTop = el.scrollHeight
		}
	}, [messages])

	const handleScroll = useCallback(() => {
		const el = scrollRef.current
		if (!el) {
			return
		}
		followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
	}, [])

	// Keep the tail visible as live chunks arrive unless the user is reading history.
	const effectiveStart = Math.max(windowStart, messages.length - INITIAL_WINDOW)
	const visible = messages.slice(Math.min(effectiveStart, messages.length))

	const loadEarlier = useCallback(() => {
		setWindowStart((w) => Math.max(0, w + LOAD_STEP))
	}, [])

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex items-center justify-between gap-2 border-b border-vscode-panel-border px-4 py-2">
				<div className="flex items-center gap-2 min-w-0">
					<Bot className="size-4 shrink-0" />
					<span className="text-xs font-medium truncate">{title}</span>
					<span className="text-vscode-descriptionForeground text-xs shrink-0">
						{ended ? t("chat:subagents.liveEnded") : t("chat:subagents.liveTitle")}
					</span>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label={t("chat:subagents.close")}>
					<ChevronDown className="size-4" />
				</Button>
			</div>

			<div className="flex-1 overflow-y-auto px-4 py-3" ref={scrollRef} onScroll={handleScroll}>
				{visible.length === 0 ? (
					<div className="text-vscode-descriptionForeground text-xs">{t("chat:subagents.noActivity")}</div>
				) : (
					<div className="space-y-4">
						{visible.map((m) => (
							<TranscriptMessage key={m.seq} message={m} t={t} />
						))}
					</div>
				)}
			</div>

			<div className="flex items-center gap-2 border-t border-vscode-panel-border px-4 py-2">
				{effectiveStart > 0 && (
					<Button variant="outline" size="sm" onClick={loadEarlier}>
						{t("chat:subagents.loadEarlier")}
					</Button>
				)}
			</div>
		</Modal>
	)
}

function TranscriptMessage({ message, t }: { message: SubagentTranscriptMessage; t: (k: string) => string }) {
	const isUser = message.role === "user"
	const HeaderIcon = isUser ? User : Bot
	return (
		<div className="group">
			<div style={HEADER_STYLE}>
				<HeaderIcon className="w-4 shrink-0" />
				<span className="font-bold">
					{isUser ? t("chat:subagents.roleUser") : t("chat:subagents.roleAssistant")}
				</span>
			</div>
			<div className="pl-6 space-y-2">
				{message.blocks.map((block, i) => (
					<BlockView key={i} block={block} user={isUser} t={t} />
				))}
			</div>
		</div>
	)
}

function BlockView({
	block,
	user,
	t,
}: {
	block: SubagentTranscriptBlock
	user: boolean
	t: (k: string) => string
}) {
	switch (block.type) {
		case "text":
			return user ? (
				<div className="px-3 py-2 rounded-md bg-vscode-editor-foreground/70 text-vscode-editor-background whitespace-pre-wrap break-words">
					{block.text}
				</div>
			) : (
				<Markdown markdown={block.text} />
			)
		case "reasoning":
			return <ReasoningCollapse text={block.text} t={t} />
		case "tool_use":
			return (
				<ToolUseBlock>
					<ToolUseBlockHeader>
						<span className="font-medium">◆ {block.name}</span>
					</ToolUseBlockHeader>
					<ToolBlockContent>{block.input}</ToolBlockContent>
				</ToolUseBlock>
			)
		case "tool_result":
			return (
				<ToolUseBlock>
					<ToolUseBlockHeader>
						<SquareTerminal className="size-3.5 shrink-0" />
						<span className="font-medium">{t("chat:subagents.result")}</span>
					</ToolUseBlockHeader>
					<ToolBlockContent>{block.content}</ToolBlockContent>
				</ToolUseBlock>
			)
		default:
			return null
	}
}

/** Chat-style tool body: monospaced, wrapped, bounded height. */
function ToolBlockContent({ children }: { children: string }) {
	return (
		<pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-vscode-foreground max-h-72 overflow-y-auto">
			{children}
		</pre>
	)
}

/** Mirrors chat's collapsible ReasoningBlock (Lightbulb + "thinking" label). */
function ReasoningCollapse({ text, t }: { text: string; t: (k: string) => string }) {
	const [open, setOpen] = useState(false)
	return (
		<div className="group">
			<div
				className="flex items-center gap-2 cursor-pointer select-none"
				onClick={() => setOpen((v) => !v)}>
				<Lightbulb className="w-4 shrink-0" />
				<span className="font-bold text-vscode-foreground">{t("chat:reasoning.thinking")}</span>
				<ChevronUp className={cn("w-4 transition-all opacity-0 group-hover:opacity-100", open && "rotate-180")} />
			</div>
			{open && text?.trim().length > 0 && (
				<div className="border-l border-vscode-descriptionForeground/20 ml-2 pl-4 pb-1 text-vscode-descriptionForeground break-words">
					<Markdown markdown={text} />
				</div>
			)}
		</div>
	)
}
