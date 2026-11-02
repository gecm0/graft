import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const tip = (b: string) => r.sh(r.repo, 'git', 'rev-parse', `refs/heads/${b}`)
const hasBranch = (b: string) => Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: r.repo, env: r.env }).exitCode === 0

// Each branch commits its own files, so every merge style applies cleanly onto main.
function work(b: string, commits = 2) {
  expect(graft(r.repo, 'create', '--branch', b, '--no-setup', '--json').code).toBe(0)
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(wt(b), `${b}-${i}.txt`), `${b} ${i}\n`)
    r.sh(wt(b), 'git', 'add', '.')
    r.sh(wt(b), 'git', 'commit', '-m', `${b} ${i}`)
  }
}

describe('remove deletes merged branches only (real git)', () => {
  const styles = ['ff', 'merge', 'squash', 'rebase']

  test('setup: four branches merged into origin/main in four styles, one left open', () => {
    writeFileSync(join(r.repo, 'graft.toml'), '[hooks]\nteardown = "echo $GRAFT_BRANCH >> \\"$GRAFT_ROOT/../teardown.log\\""\n')
    for (const b of [...styles, 'open']) work(b)
    const m = (...args: string[]) => r.sh(r.repo, 'git', ...args)
    const before = m('rev-parse', 'refs/remotes/origin/main')
    m('merge', '--ff-only', 'ff')
    m('merge', '--no-ff', '--no-edit', 'merge')
    m('merge', '--squash', 'squash')
    m('commit', '-m', 'squash merge')
    m('cherry-pick', 'main..rebase') // what a forge's "rebase and merge" does: new commits, same changes
    m('push', 'origin', 'main')
    // The local clone doesn't know yet; graft's own fetch has to pick it up.
    m('update-ref', 'refs/remotes/origin/main', before)
  })

  test('list reports facts from local refs; status fetches first', () => {
    const rows = JSON.parse(graft(r.repo, 'list', '--json').out)
    expect(rows[0]).toMatchObject({ main: true, merged: false })
    expect(rows.find((w: { branch: string }) => w.branch === 'open')).toMatchObject({ dirty: false, ahead: 2, behind: 0, merged: false })
    // Locally origin/main is still old, so squash isn't proven yet.
    expect(rows.find((w: { branch: string }) => w.branch === 'squash')).toMatchObject({ merged: false })

    const res = graft(r.repo, 'status', 'squash', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toEqual({
      path: wt('squash'), branch: 'squash', base: 'origin/main', upstream: null, dirty: false, ahead: 2, behind: 8, merged: true, space: null, pr: null,
    })
    expect(JSON.parse(graft(wt('open'), 'status', '--json').out)).toMatchObject({ path: wt('open'), merged: false })
  })

  test('a dirty worktree is refused without --force', () => {
    writeFileSync(join(wt('open'), 'scratch.txt'), 'wip\n')
    const res = graft(r.repo, 'remove', wt('open'), '--json')
    expect(res.code).toBe(6)
    expect(JSON.parse(res.out).error.kind).toBe('dirty')
    expect(existsSync(wt('open'))).toBe(true)
    rmSync(join(wt('open'), 'scratch.txt'))
  })

  for (const b of styles) {
    test(`${b}-merged: worktree removed and branch deleted`, () => {
      const head = tip(b)
      const res = graft(r.repo, 'remove', wt(b), '--json')
      expect(res.code).toBe(0)
      expect(JSON.parse(res.out)).toEqual({ removed: wt(b), teardown: { ran: true, exit: 0 }, branch: { name: b, deleted: true, head } })
      expect(existsSync(wt(b))).toBe(false)
      expect(hasBranch(b)).toBe(false)
      expect(Bun.spawnSync(['git', 'config', '--get', `branch.${b}.graft-base`], { cwd: r.repo, env: r.env }).exitCode).not.toBe(0)
    })
  }

  test('an open branch is kept, with its head reported', () => {
    const head = tip('open')
    const res = graft(r.repo, 'remove', 'open', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out).branch).toEqual({ name: 'open', deleted: false, reason: 'not-merged', head })
    expect(existsSync(wt('open'))).toBe(false)
    expect(tip('open')).toBe(head)
    expect(readFileSync(join(r.dir, 'teardown.log'), 'utf8')).toBe('ff\nmerge\nsquash\nrebase\nopen\n')
  })

  test('a failing teardown leaves everything in place; graft teardown runs it alone', () => {
    work('later', 1)
    writeFileSync(join(r.repo, 'graft.toml'), '[hooks]\nteardown = "exit 3"\n')
    const res = graft(r.repo, 'remove', 'later', '--json')
    expect(res.code).toBe(9)
    expect(existsSync(wt('later'))).toBe(true)
    expect(hasBranch('later')).toBe(true)
    expect(graft(wt('later'), 'teardown', '--json').code).toBe(9)
    // From inside the worktree being removed: the cwd vanishes mid-command.
    expect(graft(wt('later'), 'remove', '.', '--ignore-teardown', '--json').code).toBe(0)
    expect(existsSync(wt('later'))).toBe(false)
  })
})
