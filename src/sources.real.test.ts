import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realRepo } from './test/real-git.ts'

const cli = join(import.meta.dir, 'cli.ts')
const r = realRepo()
afterAll(r.cleanup)

function graft(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['bun', cli, ...args], { cwd, env: r.env, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const wt = (name: string) => join(r.dir, 'repo.worktrees', name)
const git = (cwd: string, ...args: string[]) => r.sh(cwd, 'git', ...args)

describe('--remote, --from, --title and search branches (real git)', () => {
  test('setup: "feat" exists only on origin, with one commit of its own', () => {
    git(r.seed, 'checkout', '-b', 'feat')
    writeFileSync(join(r.seed, 'feat.txt'), 'feat\n')
    git(r.seed, 'add', '.')
    // A later date than main's commit, so "newest first" is deterministic.
    const env = { ...r.env, GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z' }
    expect(Bun.spawnSync(['git', 'commit', '-m', 'feat'], { cwd: r.seed, env }).exitCode).toBe(0)
    git(r.seed, 'push', r.origin, 'feat')
  })

  test('search branches lists local and remote branches apart, without HEAD', () => {
    git(r.repo, 'fetch', 'origin')
    const hits = JSON.parse(graft(r.repo, 'search', 'branches', '--json').out)
    expect(hits.map((h: { ref: string }) => h.ref).sort()).toEqual(['refs/heads/main', 'refs/remotes/origin/feat', 'refs/remotes/origin/main'])
    expect(hits).toContainEqual({ name: 'main', where: 'local', ref: 'refs/heads/main', date: expect.any(String) })
    expect(hits).toContainEqual({ name: 'main', where: 'remote', ref: 'refs/remotes/origin/main', date: expect.any(String) })
    expect(hits[0].name).toBe('feat') // newest first
    expect(JSON.parse(graft(r.repo, 'search', 'branches', 'FE', '--json').out)).toEqual([expect.objectContaining({ name: 'feat', where: 'remote' })])
    expect(graft(r.repo, 'search', 'nope', '--json').code).toBe(2)
  })

  test('--remote feat checks out a local feat tracking origin/feat, with no base', () => {
    const res = graft(r.repo, 'create', '--remote', 'feat', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toEqual({ worktree: wt('feat'), branch: 'feat', base: null, files: { linked: [], copied: [], skipped: [] }, setup: { ran: false, exit: null } })
    expect(git(wt('feat'), 'rev-parse', '--abbrev-ref', 'feat@{upstream}')).toBe('origin/feat')
    expect(git(wt('feat'), 'rev-parse', 'HEAD')).toBe(git(r.repo, 'rev-parse', 'origin/feat'))
    expect(git(r.repo, 'config', '--get', 'branch.feat.graft-preserve')).toBe('true')
    expect(JSON.parse(graft(r.repo, 'create', '--remote', 'feat', '--json').out).error.kind).toBe('exists')
    expect(JSON.parse(graft(r.repo, 'create', '--remote', 'nope', '--json').out).error.kind).toBe('not-found')
  })

  test('--from feat starts a new branch at feat and records it as the base', () => {
    const res = graft(r.repo, 'create', '--from', 'feat', '--branch', 'feat-next', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toMatchObject({ worktree: wt('feat-next'), branch: 'feat-next', base: 'feat' })
    expect(git(wt('feat-next'), 'rev-parse', 'HEAD')).toBe(git(r.repo, 'rev-parse', 'refs/heads/feat'))
    expect(git(r.repo, 'config', '--get', 'branch.feat-next.graft-base')).toBe('refs/heads/feat')
  })

  test('--title renders the template, with {user} from the user config', () => {
    mkdirSync(join(r.env.XDG_CONFIG_HOME!, 'graft'), { recursive: true })
    writeFileSync(join(r.env.XDG_CONFIG_HOME!, 'graft', 'config.toml'), 'user = "alice"\n')
    writeFileSync(join(r.repo, 'graft.toml'), '[branch]\ntemplate = "{user}/{key}-{slug}"\n')
    const res = graft(r.repo, 'create', '--title', 'Fix the Login!', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toMatchObject({ worktree: wt('alice-fix-the-login'), branch: 'alice/fix-the-login', base: 'origin/main' })
    // --branch stays literal whatever the template says.
    expect(JSON.parse(graft(r.repo, 'create', '--branch', 'plain', '--no-setup', '--json').out).branch).toBe('plain')
  })

  test('remove keeps the preserved --remote branch even though it is on origin', () => {
    const head = git(r.repo, 'rev-parse', 'refs/heads/feat')
    const res = graft(r.repo, 'remove', 'feat', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out).branch).toEqual({ name: 'feat', deleted: false, reason: 'preserved', head })
    expect(existsSync(wt('feat'))).toBe(false)
    expect(git(r.repo, 'rev-parse', 'refs/heads/feat')).toBe(head)
  })

  test('PRs need a known forge: a remote on disk has none', () => {
    expect(JSON.parse(graft(r.repo, 'search', 'prs', '--json').out).error.kind).toBe('unsupported')
    expect(JSON.parse(graft(r.repo, 'create', '--pr', '1', '--json').out).error.kind).toBe('unsupported')
    expect(JSON.parse(graft(r.repo, 'create', '--pr', '1', '--base', 'main', '--json').out).error.kind).toBe('usage')
    // status and list --pr report none instead of failing.
    expect(JSON.parse(graft(wt('feat-next'), 'status', '--json').out).pr).toBeNull()
    const rows = JSON.parse(graft(r.repo, 'list', '--pr', '--json').out)
    expect(rows.map((w: { pr: unknown }) => w.pr)).toEqual(rows.map(() => null))
    expect(JSON.parse(graft(r.repo, 'list', '--json').out)[0]).not.toHaveProperty('pr')
  })

  test('--remote reuses a local branch as is', () => {
    const res = graft(r.repo, 'create', '--remote', 'feat', '--no-setup', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out)).toMatchObject({ worktree: wt('feat'), branch: 'feat', base: null })
  })
})
