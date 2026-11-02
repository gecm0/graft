import { loadRepoConfig } from '../config.ts'
import { context, listWorktrees, pickRemote } from '../git.ts'
import type { Pr } from '../forge/forge.ts'
import { showing, spaces } from '../herdr.ts'
import type { Io } from '../io.ts'
import { worktreeFacts, worktreePr, type Facts } from './status.ts'

// space: the id of the Herdr space showing the worktree, null without one (or without Herdr).
// pr is only there with withPr (list --pr).
export type ListRow = {
  path: string; branch: string | null; head: string | null; main: boolean; locked: boolean; prunable: boolean
  space: string | null; pr?: Pr | null
} & Facts

// Facts are computed from local refs only (no fetch), so list stays fast and offline
// (Herdr's spaces are two local calls);
// withPr asks the forge for each worktree's PR, one CLI call per row, a few at a time:
// one after another, many worktrees would outlast the Herdr panel's 30 s exec limit.
export async function list(io: Io, withPr = false): Promise<ListRow[]> {
  const ctx = await context(io)
  const cfg = await loadRepoConfig(io, ctx.main)
  const remote = await pickRemote(io, ctx.main, cfg.remote)
  const all = await spaces(io)
  const worktrees = (await listWorktrees(io, ctx)).filter((w) => !w.bare)
  const rows: ListRow[] = []
  for (const w of worktrees) {
    const { upstream: _, ...facts } = await worktreeFacts(io, ctx.main, w, remote, false, cfg.link)
    const { path, branch, head, main, locked, prunable } = w
    rows.push({ path, branch, head, main, locked, prunable, ...facts, space: showing(all, path, worktrees.map((x) => x.path))[0]?.id ?? null })
  }
  if (withPr) {
    let next = 0
    const worker = async () => {
      for (let i = next++; i < rows.length; i = next++) rows[i]!.pr = await worktreePr(io, ctx.main, worktrees[i]!, remote)
    }
    await Promise.all(Array.from({ length: prConcurrency }, worker))
  }
  return rows
}

const prConcurrency = 4
