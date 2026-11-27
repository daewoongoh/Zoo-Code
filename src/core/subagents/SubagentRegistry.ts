import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import matter from "gray-matter"
import type { SubagentDefinition, SubagentSource } from "@roo-code/types"

import { subagentDefinitionSchema, subagentFrontmatterSchema } from "@roo-code/types"

export interface ParseSubagentResult {
	definition?: SubagentDefinition
	error?: string
}

/**
 * Parses a Markdown agent definition.
 *
 * The frontmatter supplies the metadata; the body is the system prompt. A file
 * without frontmatter keeps the whole body as the prompt and derives the name
 * from the file name, which matches how `.claude/agents` files are often
 * written. Validation failures return an error instead of throwing so a single
 * broken file never blocks the rest of the registry.
 */
export function parseSubagentMarkdown(
	raw: string,
	options: { source: SubagentSource; filePath: string; fallbackName?: string },
): ParseSubagentResult {
	let parsed: { data: Record<string, unknown>; content: string }

	try {
		parsed = matter(raw)
	} catch (error) {
		return { error: `Invalid frontmatter in ${options.filePath}: ${(error as Error).message}` }
	}

	const frontmatterResult = subagentFrontmatterSchema.safeParse(parsed.data ?? {})

	if (!frontmatterResult.success) {
		return { error: `Invalid frontmatter in ${options.filePath}: ${frontmatterResult.error.message}` }
	}

	const frontmatter = frontmatterResult.data
	const fallback = options.fallbackName ?? path.basename(options.filePath, path.extname(options.filePath))
	const name = frontmatter.name ?? fallback
	const systemPrompt = parsed.content.trim()

	if (!systemPrompt) {
		return { error: `Agent file ${options.filePath} has an empty system prompt` }
	}

	const description = frontmatter.description ?? `Custom subagent defined in ${path.basename(options.filePath)}.`

	const candidate = {
		...frontmatter,
		name,
		description,
		systemPrompt,
		source: options.source,
	}

	const result = subagentDefinitionSchema.safeParse(candidate)

	if (!result.success) {
		return { error: `Invalid agent definition in ${options.filePath}: ${result.error.message}` }
	}

	return { definition: result.data }
}

/**
 * Location a registry scans, in precedence order (first wins).
 */
export interface SubagentSourceDirectory {
	path: string
	source: SubagentSource
}

export function getSubagentSourceDirectories(cwd: string, homeDir: string = os.homedir()): SubagentSourceDirectory[] {
	return [
		{ path: path.join(cwd, ".zoo", "agents"), source: "project" },
		{ path: path.join(cwd, ".claude", "agents"), source: "project" },
		{ path: path.join(homeDir, ".zoo", "agents"), source: "user" },
	]
}

export interface SubagentRegistryOptions {
	cwd: string
	homeDir?: string
	/** Called for every skipped or replaced definition. */
	onWarning?: (message: string) => void
	/** Set false in tests to avoid touching the VS Code file watcher. */
	watch?: boolean
}

/**
 * Resolves the subagent definitions available to a workspace.
 *
 * Precedence: `.zoo/agents` > `.claude/agents` > `~/.zoo/agents` > builtins.
 * A project definition overrides a user definition with the same name, and any
 * definition overrides a builtin.
 */
export class SubagentRegistry {
	private definitions = new Map<string, SubagentDefinition>()
	private watchers: Array<{ dispose(): void }> = []
	private reloadTimer?: NodeJS.Timeout
	private disposed = false
	private readonly options: Required<Pick<SubagentRegistryOptions, "cwd" | "homeDir" | "watch">> &
		Pick<SubagentRegistryOptions, "onWarning">

	constructor(options: SubagentRegistryOptions) {
		this.options = {
			cwd: options.cwd,
			homeDir: options.homeDir ?? os.homedir(),
			watch: options.watch ?? true,
			onWarning: options.onWarning,
		}
	}

	/** Loads builtins first, then project/user files, then starts watchers. */
	async load(): Promise<void> {
		this.definitions.clear()
		for (const definition of getBuiltinSubagents()) {
			this.definitions.set(definition.name, definition)
		}

		// Lowest precedence first: a later, higher-precedence file overwrites it.
		const directories = getSubagentSourceDirectories(this.options.cwd, this.options.homeDir).reverse()

		for (const directory of directories) {
			await this.loadDirectory(directory.path, directory.source)
		}

		this.startWatching()
	}

	get(name: string): SubagentDefinition | undefined {
		return this.definitions.get(name)
	}

	getAll(): SubagentDefinition[] {
		return [...this.definitions.values()].sort((a, b) => {
			const rank = (definition: SubagentDefinition) =>
				definition.source === "project" ? 0 : definition.source === "user" ? 1 : 2
			return rank(a) - rank(b) || a.name.localeCompare(b.name)
		})
	}

	/** Compact catalog for the `spawn_subagent` tool description. */
	getCatalog(): Array<{ name: string; description: string }> {
		return this.getAll().map(({ name, description }) => ({ name, description }))
	}

	has(name: string): boolean {
		return this.definitions.has(name)
	}

	dispose(): void {
		this.disposed = true
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer)
			this.reloadTimer = undefined
		}
		for (const watcher of this.watchers) {
			watcher.dispose()
		}
		this.watchers = []
		this.definitions.clear()
	}

	private async loadDirectory(directory: string, source: SubagentSource): Promise<void> {
		let entries: string[]
		try {
			entries = await fs.readdir(directory)
		} catch {
			// Missing directories are expected: every source is optional.
			return
		}

		for (const entry of entries) {
			if (!entry.endsWith(".md") && !entry.endsWith(".mdx")) {
				continue
			}

			const filePath = path.join(directory, entry)
			try {
				const raw = await fs.readFile(filePath, "utf8")
				const { definition, error } = parseSubagentMarkdown(raw, {
					source,
					filePath,
					fallbackName: path.basename(entry, path.extname(entry)),
				})

				if (error || !definition) {
					this.options.onWarning?.(error ?? `Skipped agent file ${filePath}`)
					continue
				}

				const existing = this.definitions.get(definition.name)
				if (existing && existing.source !== "builtin") {
					this.options.onWarning?.(`Agent "${definition.name}" from ${filePath} overrides an existing definition`)
				}

				this.definitions.set(definition.name, definition)
			} catch (error) {
				this.options.onWarning?.(`Failed to read agent file ${filePath}: ${(error as Error).message}`)
			}
		}
	}

	private startWatching(): void {
		if (!this.options.watch || this.disposed || this.watchers.length > 0) {
			return
		}

		let vscode: typeof import("vscode")
		try {
			// Loaded lazily so pure consumers (and unit tests) can use the registry
			// without a VS Code extension host.
			vscode = require("vscode")
		} catch {
			return
		}

		for (const directory of getSubagentSourceDirectories(this.options.cwd, this.options.homeDir)) {
			try {
				if (!fsSync.existsSync(directory.path)) {
					continue
				}

				const watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(directory.path, "*.{md,mdx}"),
				)
				const reload = () => this.scheduleReload()
				watcher.onDidCreate(reload)
				watcher.onDidChange(reload)
				watcher.onDidDelete(reload)
				this.watchers.push(watcher)
			} catch {
				// A watcher failure must never break agent resolution.
			}
		}
	}

	private scheduleReload(): void {
		if (this.disposed) {
			return
		}
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer)
		}
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined
			void this.load()
		}, 250)
	}
}

/**
 * Built-in agents. These are intentionally narrow: `explore` and `reviewer`
 * are read-only and cheap to run in parallel; `general` can edit and is
 * serialized against other writers by the manager.
 */
export function getBuiltinSubagents(): SubagentDefinition[] {
	return [
		{
			name: "explore",
			description:
				"Read-only codebase exploration: locate symbols, trace callers and gather file facts without editing.",
			systemPrompt: [
				"You are an exploration subagent. You investigate a codebase and report facts.",
				"",
				"Rules:",
				"- Use read_file, search_files, list_files and codebase_search. Never modify files.",
				"- Work from the provided instructions. You cannot ask questions; if something is ambiguous, state the assumption and continue.",
				"- Prefer targeted searches over broad reads. Read only the files needed to answer.",
				"- Finish with attempt_completion. The result must be a compact report: findings, exact file paths with line numbers, and open questions.",
			].join("\n"),
			readonly: true,
			tools: ["read_file", "search_files", "list_files", "codebase_search", "attempt_completion", "update_todo_list"],
			maxTurns: 15,
			isolation: "none",
			color: "blue",
			source: "builtin",
		},
		{
			name: "reviewer",
			description: "Read-only code review: correctness, security, regressions and missing tests.",
			systemPrompt: [
				"You are a code review subagent. You audit code and report defects.",
				"",
				"Rules:",
				"- Read the relevant files and tests. Never modify files.",
				"- Look for correctness bugs, security issues, race conditions, missing error handling and missing tests.",
				"- Do not report style preferences unless they cause a defect.",
				"- Finish with attempt_completion. The result must list each finding as: severity, file:line, what is wrong, and why it matters. If you find nothing, say so explicitly.",
			].join("\n"),
			readonly: true,
			tools: ["read_file", "search_files", "list_files", "codebase_search", "attempt_completion", "update_todo_list"],
			maxTurns: 15,
			isolation: "none",
			color: "purple",
			source: "builtin",
		},
		{
			name: "general",
			description: "General-purpose worker that can read, edit, run tests and commands, and report back.",
			systemPrompt: [
				"You are a general-purpose subagent. You complete the delegated task and report the outcome.",
				"",
				"Rules:",
				"- Stay strictly inside the delegated scope. Do not start unrelated work.",
				"- You cannot ask the user or the parent questions. Make reasonable assumptions and state them in the final report.",
				"- Make the smallest correct change. Run the narrowest relevant test after editing.",
				"- Finish with attempt_completion. The result must summarize what changed, which files were modified, what you verified, and anything that remains.",
			].join("\n"),
			readonly: false,
			maxTurns: 20,
			isolation: "none",
			color: "green",
			source: "builtin",
		},
	]
}
