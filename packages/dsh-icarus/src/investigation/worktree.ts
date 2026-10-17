// Git worktree lifecycle for code investigations.
//
// A code investigation works in its own linked worktree, so the original checkout keeps its
// branch and its uncommitted changes untouched. The worktree path is derived from the Mission id,
// which makes a retry find the same worktree instead of creating a second one: an existing
// worktree is read back (branch and HEAD) rather than re-added.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface WorktreeInfo {
  readonly worktreeRef: string
  readonly branch: string
  readonly baseCommit: string
}

export interface WorktreeChanges {
  readonly diff: string
  readonly status: string
  readonly head: string
  readonly baseCommit: string
}

/** Create the linked worktree of one investigation, or read back the one a retry already has. */
export function ensureWorktree(input: { repoPath: string; dataDir: string; missionId: string }): WorktreeInfo {
  const repo = resolve(input.repoPath)
  if (!existsSync(repo)) throw new Error(`icarus: repository ${JSON.stringify(input.repoPath)} does not exist`)
  const top = resolve(git(repo, ['rev-parse', '--show-toplevel']).trim())
  if (!containsPath(top, repo)) {
    throw new Error(`icarus: ${JSON.stringify(input.repoPath)} is outside the git work tree ${JSON.stringify(top)}`)
  }
  const target = join(resolve(input.dataDir), 'investigations', input.missionId)
  if (existsSync(join(target, '.git'))) {
    const status = worktreeStatus(target)
    return { worktreeRef: target, branch: status.branch, baseCommit: status.head }
  }
  const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()
  const branch = branchOf(input.missionId)
  mkdirSync(dirname(target), { recursive: true })
  git(repo, ['worktree', 'add', '-b', branch, target, baseCommit])
  return { worktreeRef: target, branch, baseCommit }
}

/** Commit the investigation worktree (when it has changes) and capture its diff from the base commit. */
export function captureWorktree(input: { worktreeRef: string; baseCommit: string; missionId: string }): WorktreeChanges {
  const worktree = resolve(input.worktreeRef)
  const status = git(worktree, ['status', '--porcelain'])
  if (status.trim() !== '') {
    git(worktree, ['add', '-A'])
    git(worktree, ['-c', 'user.name=Icarus', '-c', 'user.email=icarus@investigations.local', 'commit', '--no-verify', '-m', 'Icarus investigation ' + input.missionId])
  }
  const head = git(worktree, ['rev-parse', 'HEAD']).trim()
  const diff = git(worktree, ['diff', input.baseCommit + '..' + head])
  return { diff, status, head, baseCommit: input.baseCommit }
}

/** Branch and HEAD of an existing worktree. */
export function worktreeStatus(path: string): { branch: string; head: string } {
  const worktree = resolve(path)
  return {
    branch: git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    head: git(worktree, ['rev-parse', 'HEAD']).trim(),
  }
}

/** Whether `path` is the work tree root or a directory below it, compared per platform rules. */
function containsPath(root: string, path: string): boolean {
  const base = normalizedPath(root)
  const target = normalizedPath(path)
  return target === base || target.startsWith(`${base}/`)
}

function normalizedPath(path: string): string {
  const value = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** Branch name of one investigation; the Mission id suffix keeps it unique per inquiry. */
function branchOf(missionId: string): string {
  const cut = missionId.lastIndexOf('_')
  const suffix = cut === -1 ? missionId : missionId.slice(cut + 1)
  return `icarus/investigate-${(suffix === '' ? missionId : suffix).slice(0, 8)}`
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd })
  if (result.error !== undefined) throw new Error(`icarus: git ${args.join(' ')} failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = result.stderr.trim() === '' ? `exit ${result.status ?? 'unknown'}` : result.stderr.trim()
    throw new Error(`icarus: git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout
}
