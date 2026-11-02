import { defaultBranch, fetchBranch, splitRemoteRef } from './git.ts'
import type { Io } from './io.ts'

// A branch is merged into a target when its tip is an ancestor of the target (ff, merge),
// or when merging it into the target changes nothing (squash, rebase): merge-tree == target^{tree}.
export async function isMerged(io: Io, cwd: string, tip: string, targets: string[]): Promise<boolean> {
  for (const target of targets) {
    const tree = await io.run(['git', 'rev-parse', '--verify', '--quiet', `${target}^{tree}`], { cwd })
    if (tree.code !== 0) continue // target ref missing
    if ((await io.run(['git', 'merge-base', '--is-ancestor', tip, target], { cwd })).code === 0) return true
    // Non-zero exit means conflicts, which can't be "already merged".
    const merge = await io.run(['git', 'merge-tree', '--write-tree', target, tip], { cwd })
    if (merge.code === 0 && merge.out.split('\n')[0] === tree.out.trim()) return true
  }
  return false
}

// Refs to prove a branch merged against: its recorded graft-base, then the remote's default branch.
// With fetch, both are fetched first (failures warn and fall back to local refs);
// without, nothing touches the network.
export async function mergeTargets(io: Io, cwd: string, branch: string, remote: string, fetch: boolean): Promise<string[]> {
  const targets: string[] = []
  const base = (await io.run(['git', 'config', '--get', `branch.${branch}.graft-base`], { cwd })).out.trim()
  if (base) targets.push(base)
  if (fetch) {
    try {
      targets.push(`refs/remotes/${remote}/${await defaultBranch(io, cwd, remote)}`)
    } catch (e) {
      io.warn(`${(e as Error).message}; checking against the recorded base only`)
    }
  } else {
    targets.push(`refs/remotes/${remote}/HEAD`)
  }
  const unique = [...new Set(targets)]
  if (fetch) {
    // Each through its own remote: a base on upstream must not be judged by a stale upstream ref.
    for (const t of unique) {
      const r = await splitRemoteRef(io, cwd, t, remote)
      if (r) await fetchBranch(io, cwd, r.remote, r.branch)
    }
  }
  return unique
}

// Compare-and-delete: refuses if the branch moved away from `tip` since it was checked.
export async function deleteBranch(io: Io, cwd: string, branch: string, tip: string): Promise<void> {
  const r = await io.run(['git', 'update-ref', '-d', `refs/heads/${branch}`, tip], { cwd })
  if (r.code !== 0) throw new Error(`could not delete branch ${branch}: ${r.err.trim()}`)
  // Drops graft-base/graft-preserve and any upstream settings, as `git branch -d` would.
  await io.run(['git', 'config', '--remove-section', `branch.${branch}`], { cwd })
}
