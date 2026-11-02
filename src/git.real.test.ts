import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { context, listWorktrees } from './git.ts'
import { systemIo } from './io.ts'
import { realRepo } from './test/real-git.ts'

const cli = join(import.meta.dir, 'cli.ts')
const r = realRepo()
afterAll(r.cleanup)

function graft(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['bun', cli, ...args], { cwd, env: r.env, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('real git', () => {
  const wt = join(r.dir, 'repo.worktrees', 'foo')

  test('create --branch foo makes <parent>/<repo>.worktrees/foo from origin/main and runs setup', () => {
    writeFileSync(join(r.repo, 'graft.toml'), '[hooks]\nsetup = """\necho "$GRAFT_BRANCH $GRAFT_BASE" > setup-ran.txt\necho hook says hi\n"""\n')
    const res = graft(r.repo, 'create', '--branch', 'foo', '--json')
    expect(res.code).toBe(0)
    // Exactly one JSON object on stdout; the hook's own output went to stderr.
    expect(JSON.parse(res.out)).toEqual({ worktree: wt, branch: 'foo', base: 'origin/main', files: { linked: [], copied: [], skipped: [] }, setup: { ran: true, exit: 0 } })
    expect(res.err).toContain('hook says hi')

    expect(readFileSync(join(wt, 'setup-ran.txt'), 'utf8')).toBe('foo origin/main\n')
    expect(r.sh(r.repo, 'git', 'config', '--get', 'branch.foo.graft-base')).toBe('refs/remotes/origin/main')
    expect(r.sh(wt, 'git', 'rev-parse', 'HEAD')).toBe(r.sh(r.repo, 'git', 'rev-parse', 'origin/main'))
    // --no-track: no upstream on the new branch.
    expect(Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'foo@{upstream}'], { cwd: wt, env: r.env }).exitCode).not.toBe(0)
  })

  test('list --json includes it', () => {
    const res = graft(r.repo, 'list', '--json')
    expect(res.code).toBe(0)
    const rows = JSON.parse(res.out)
    expect(rows[0]).toMatchObject({ path: r.repo, branch: 'main', main: true })
    expect(rows).toContainEqual(expect.objectContaining({ path: wt, branch: 'foo', main: false, locked: false, prunable: false }))
  })

  test('context inside the linked worktree points at the main checkout', async () => {
    const ctx = await context(systemIo(r.env, wt))
    expect(ctx).toMatchObject({ root: wt, main: r.repo, common: join(r.repo, '.git'), linked: true })
    expect((await listWorktrees(systemIo(r.env, wt), ctx)).map((w) => w.path)).toEqual([r.repo, wt])
  })

  test('graft setup reruns the hook from inside the worktree', () => {
    Bun.spawnSync(['rm', join(wt, 'setup-ran.txt')])
    const res = graft(wt, 'setup', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toEqual({ worktree: wt, files: { linked: [], copied: [], skipped: [] }, setup: { ran: true, exit: 0 } })
    expect(readFileSync(join(wt, 'setup-ran.txt'), 'utf8')).toBe('foo origin/main\n')
  })

  test('a failing setup exits with setup-failed and keeps the worktree', () => {
    writeFileSync(join(r.repo, 'graft.toml'), '[hooks]\nsetup = """\nfalse\necho unreachable > after.txt\n"""\n')
    const res = graft(r.repo, 'create', '--branch', 'bar', '--json')
    expect(res.code).toBe(8)
    expect(JSON.parse(res.out).error).toMatchObject({ kind: 'setup-failed' })
    const bar = join(r.dir, 'repo.worktrees', 'bar')
    expect(existsSync(bar)).toBe(true)
    expect(existsSync(join(bar, 'after.txt'))).toBe(false) // bash -e stopped at `false`
  })

  test('an existing branch and a non-repo cwd are typed errors', () => {
    expect(JSON.parse(graft(r.repo, 'create', '--branch', 'foo', '--json').out).error.kind).toBe('exists')
    expect(JSON.parse(graft(r.dir, 'list', '--json').out).error.kind).toBe('not-a-repo')
    expect(graft(r.repo, 'create', '--json').code).toBe(2)
  })
})

test('a --single-branch clone: a branch checked out with --remote still has an upstream in status', () => {
  r.sh(r.seed, 'git', 'checkout', '-b', 'topic')
  r.sh(r.seed, 'git', 'commit', '--allow-empty', '-m', 'topic')
  r.sh(r.seed, 'git', 'push', r.origin, 'topic')
  const single = join(r.dir, 'single')
  r.sh(r.dir, 'git', 'clone', '--single-branch', '-b', 'main', r.origin, single)
  const res = graft(single, 'create', '--remote', 'topic', '--no-setup', '--json')
  expect(res.code).toBe(0)
  const wt = JSON.parse(res.out).worktree
  r.sh(wt, 'git', 'commit', '--allow-empty', '-m', 'local')
  expect(JSON.parse(graft(single, 'status', 'topic', '--json').out)).toMatchObject({ upstream: 'origin/topic', ahead: 1, behind: 0 })
  // Nothing was added to the remote's fetch refspecs.
  expect(r.sh(single, 'git', 'config', '--get-all', 'remote.origin.fetch')).toBe('+refs/heads/main:refs/remotes/origin/main')
})
