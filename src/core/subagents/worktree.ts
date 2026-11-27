import { execa } from "execa"

export interface WorktreeInfo {
	path: string
	kept: boolean
	filesChanged?: number
	diffStat?: string
}

export interface CreateWorktreeOptions {
	repoPath: string
	/** Directory the worktree is created in. Must not exist yet. */
	worktreePath: string
	/** Ref to check out. Detached HEAD keeps branches untouched. */
	ref?: string
	log?: (message: string) => void
}

/**
 * Creates a temporary detached worktree for one subagent run.
 *
 * Returns `undefined` when the workspace is not a git repository, or when the
 * worktree cannot be created. In that case the run falls back to the parent
 * workspace instead of failing.
 */
export async function createSubagentWorktree(options: CreateWorktreeOptions): Promise<string | undefined> {
	const { repoPath, worktreePath, ref = "HEAD", log } = options

	try {
		await execa("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000 })
	} catch {
		log?.(`[subagent] ${repoPath} is not a git worktree; running in the workspace`)
		return undefined
	}

	try {
		await execa("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, ref], { timeout: 60_000 })
		return worktreePath
	} catch (error) {
		log?.(`[subagent] failed to create worktree at ${worktreePath}: ${(error as Error).message}`)
		return undefined
	}
}

/**
 * Reports what changed in a subagent worktree and removes it when it is clean.
 * A worktree with changes is kept so the parent can review or merge it.
 */
export async function finalizeSubagentWorktree(options: {
	repoPath: string
	worktreePath: string
	log?: (message: string) => void
}): Promise<WorktreeInfo> {
	const { repoPath, worktreePath, log } = options

	let status = ""
	let diffStat = ""

	try {
		const { stdout } = await execa("git", ["-C", worktreePath, "status", "--porcelain"], { timeout: 20_000 })
		status = stdout
		const { stdout: stat } = await execa("git", ["-C", worktreePath, "diff", "HEAD", "--stat"], {
			timeout: 20_000,
		})
		diffStat = stat
	} catch (error) {
		log?.(`[subagent] failed to inspect worktree ${worktreePath}: ${(error as Error).message}`)
	}

	const filesChanged = status
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0).length

	if (filesChanged === 0) {
		try {
			await execa("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], { timeout: 30_000 })
			return { path: worktreePath, kept: false, filesChanged: 0 }
		} catch (error) {
			log?.(`[subagent] failed to remove clean worktree ${worktreePath}: ${(error as Error).message}`)
			return { path: worktreePath, kept: true, filesChanged: 0 }
		}
	}

	return { path: worktreePath, kept: true, filesChanged, diffStat: diffStat.trim() || undefined }
}
