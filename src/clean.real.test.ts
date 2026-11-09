import { afterAll, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realRepo } from './test/real-git.ts'

const cli = join(import.meta.dir, 'cli.ts')
const r = realRepo()
afterAll(r.cleanup)

function graft(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['bun', cli, ...args], { cwd, env: r.env, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const wt = (b: string) => join(r.dir, 'repo.worktrees', b)
const hasBranch = (b: string) => Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: r.repo, env: r.env }).exitCode === 0

test('clean removes only the clean, merged worktree and deletes its branch (real git)', () => {
  for (const b of ['merged', 'dirty', 'open']) {
    expect(graft(r.repo, 'create', '--branch', b, '--no-setup', '--json').code).toBe(0)
    writeFileSync(join(wt(b), `${b}.txt`), `${b}\n`)
    r.sh(wt(b), 'git', 'add', '.')
    r.sh(wt(b), 'git', 'commit', '-m', b)
  }
  // merged and dirty both land on origin/main; dirty then gets an untracked file.
  const before = r.sh(r.repo, 'git', 'rev-parse', 'refs/remotes/origin/main')
  r.sh(r.repo, 'git', 'merge', '--no-ff', '--no-edit', 'merged', 'dirty')
  r.sh(r.repo, 'git', 'push', 'origin', 'main')
  // The clone's origin/main is stale again: clean's own fetch has to see the merges.
  r.sh(r.repo, 'git', 'update-ref', 'refs/remotes/origin/main', before)
  writeFileSync(join(wt('dirty'), 'scratch.txt'), 'wip\n')
  // Just created from origin/main, no commits: its tip is an ancestor, but it must stay.
  expect(graft(r.repo, 'create', '--branch', 'fresh', '--no-setup', '--json').code).toBe(0)
  r.sh(wt('fresh'), 'git', 'reset', '--hard', 'HEAD')

  const skipped = [
    { path: wt('dirty'), branch: 'dirty', reason: 'dirty' },
    { path: wt('fresh'), branch: 'fresh', reason: 'no-commits' },
    { path: wt('open'), branch: 'open', reason: 'not-merged' },
  ]

  // Not a terminal and no --yes: a dry run.
  const dry = graft(r.repo, 'clean', '--json')
  expect(dry.code).toBe(0)
  expect(JSON.parse(dry.out)).toEqual({ dryRun: true, candidates: [{ path: wt('merged'), branch: 'merged' }], removed: [], skipped, failed: [] })
  expect(existsSync(wt('merged'))).toBe(true)

  const head = r.sh(r.repo, 'git', 'rev-parse', 'refs/heads/merged')
  const res = graft(r.repo, 'clean', '--yes', '--json')
  expect(res.code).toBe(0)
  expect(JSON.parse(res.out)).toEqual({
    dryRun: false,
    candidates: [{ path: wt('merged'), branch: 'merged' }],
    removed: [{ path: wt('merged'), branch: { name: 'merged', deleted: true, head } }],
    skipped,
    failed: [],
  })
  expect(existsSync(wt('merged'))).toBe(false)
  expect(hasBranch('merged')).toBe(false)
  for (const b of ['dirty', 'open', 'fresh']) {
    expect(existsSync(wt(b))).toBe(true)
    expect(hasBranch(b)).toBe(true)
  }
})
