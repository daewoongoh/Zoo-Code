// npx vitest run core/subagents/__tests__/SubagentRegistry.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { getBuiltinSubagents, parseSubagentMarkdown, SubagentRegistry } from "../SubagentRegistry"

async function makeTempRoot(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "zoo-subagent-registry-"))
}

async function writeAgent(root: string, relativePath: string, content: string): Promise<void> {
	const filePath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, content, "utf8")
}

describe("parseSubagentMarkdown", () => {
	it("reads frontmatter metadata and the body as the system prompt", () => {
		const result = parseSubagentMarkdown(
			[
				"---",
				"name: reviewer",
				"description: Reviews changes",
				"tools: read_file, search_files",
				"readonly: true",
				"maxTurns: 7",
				"---",
				"You review code.",
			].join("\n"),
			{ source: "project", filePath: "/workspace/.zoo/agents/reviewer.md" },
		)

		expect(result.error).toBeUndefined()
		expect(result.definition).toMatchObject({
			name: "reviewer",
			description: "Reviews changes",
			systemPrompt: "You review code.",
			tools: ["read_file", "search_files"],
			readonly: true,
			maxTurns: 7,
			source: "project",
		})
	})

	it("derives the name from the file name when frontmatter has none", () => {
		const result = parseSubagentMarkdown("Inspect the module.", {
			source: "user",
			filePath: "/home/user/.zoo/agents/scout.md",
		})

		expect(result.definition?.name).toBe("scout")
		expect(result.definition?.description).toContain("scout.md")
		expect(result.definition?.systemPrompt).toBe("Inspect the module.")
	})

	it("rejects an empty system prompt", () => {
		const result = parseSubagentMarkdown("---\nname: empty\n---\n   ", {
			source: "project",
			filePath: "/workspace/.zoo/agents/empty.md",
		})

		expect(result.definition).toBeUndefined()
		expect(result.error).toContain("empty system prompt")
	})

	it("rejects invalid frontmatter without throwing", () => {
		const result = parseSubagentMarkdown("---\nmaxTurns: 0\n---\nbody", {
			source: "project",
			filePath: "/workspace/.zoo/agents/bad.md",
		})

		expect(result.definition).toBeUndefined()
		expect(result.error).toContain("Invalid frontmatter")
	})
})

describe("SubagentRegistry", () => {
	let root: string
	let cwd: string
	let homeDir: string

	beforeEach(async () => {
		root = await makeTempRoot()
		cwd = path.join(root, "workspace")
		homeDir = path.join(root, "home")
		await fs.mkdir(cwd, { recursive: true })
		await fs.mkdir(homeDir, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("loads the builtin agents when no agent directories exist", async () => {
		const registry = new SubagentRegistry({ cwd, homeDir, watch: false })
		await registry.load()

		expect(registry.getAll().map((definition) => definition.name)).toEqual([
			"explore",
			"general",
			"reviewer",
		])
		expect(registry.getCatalog()).toEqual(
			expect.arrayContaining([{ name: "explore", description: expect.any(String) }]),
		)
		registry.dispose()
	})

	it("applies project > .claude > user > builtin precedence by agent name", async () => {
		await writeAgent(cwd, ".zoo/agents/explore.md", "---\ndescription: project explore\n---\nproject prompt")
		await writeAgent(cwd, ".claude/agents/helper.md", "---\ndescription: claude helper\n---\nclaude prompt")
		await writeAgent(homeDir, ".zoo/agents/explore.md", "---\ndescription: user explore\n---\nuser prompt")
		await writeAgent(homeDir, ".zoo/agents/personal.md", "---\ndescription: personal\n---\npersonal prompt")

		const registry = new SubagentRegistry({ cwd, homeDir, watch: false })
		await registry.load()

		expect(registry.get("explore")?.description).toBe("project explore")
		expect(registry.get("explore")?.systemPrompt).toBe("project prompt")
		expect(registry.get("helper")?.description).toBe("claude helper")
		expect(registry.get("personal")?.source).toBe("user")
		registry.dispose()
	})

	it("skips a broken file, warns, and still loads the rest", async () => {
		const warnings: string[] = []
		await writeAgent(cwd, ".zoo/agents/broken.md", "---\nmaxTurns: nope\n---\nbody")
		await writeAgent(cwd, ".zoo/agents/good.md", "---\ndescription: good\n---\ngood prompt")

		const registry = new SubagentRegistry({
			cwd,
			homeDir,
			watch: false,
			onWarning: (message) => warnings.push(message),
		})
		await registry.load()

		expect(registry.has("good")).toBe(true)
		expect(registry.has("broken")).toBe(false)
		expect(warnings.some((message) => message.includes("broken.md"))).toBe(true)
		registry.dispose()
	})

	it("ignores files that are not markdown", async () => {
		await writeAgent(cwd, ".zoo/agents/notes.txt", "not an agent")
		const registry = new SubagentRegistry({ cwd, homeDir, watch: false })
		await registry.load()

		expect(registry.has("notes")).toBe(false)
		registry.dispose()
	})

	it("ships builtins with a read-only class for explore and reviewer", () => {
		const builtins = new Map(getBuiltinSubagents().map((definition) => [definition.name, definition]))

		expect(builtins.get("explore")?.readonly).toBe(true)
		expect(builtins.get("reviewer")?.readonly).toBe(true)
		expect(builtins.get("general")?.readonly).toBe(false)
	})
})
