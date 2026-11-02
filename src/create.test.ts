import { expect, test } from 'bun:test'
import { create } from './commands/create.ts'
import { cloneScript, fakeIo } from './test/fake-io.ts'

const toml = '[hooks]\nsetup = "make setup"\n'
const wt = '/r/repo.worktrees/foo'

test('pipeline order: check branch, fetch base, add worktree, record base, then setup', async () => {
  const io = fakeIo(cloneScript, { files: { '/r/repo/graft.toml': toml } })
  const result = await create(io, { branch: 'foo', setup: true })
  expect(result).toEqual({ worktree: wt, branch: 'foo', base: 'origin/main', files: { linked: [], copied: [], skipped: [] }, setup: { ran: true, exit: 0 } })

  const order = [
    ['git', 'check-ref-format', '--branch', 'foo'],
    ['git', 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    ['git', 'worktree', 'add', '--no-track', '-b', 'foo', wt, 'refs/remotes/origin/main'],
    ['git', 'config', 'branch.foo.graft-base', 'refs/remotes/origin/main'],
    ['bash', '-e', '-c', 'make setup'],
  ].map((cmd) => io.calls.findIndex((c) => c.join(' ') === cmd.join(' ')))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))

  const hook = io.runs.find((r) => r.cmd[0] === 'bash')!
  expect(hook.opts).toMatchObject({
    cwd: wt,
    stream: true,
    env: { GRAFT_ROOT: '/r/repo', GRAFT_WORKTREE: wt, GRAFT_BRANCH: 'foo', GRAFT_NAME: 'foo', GRAFT_BASE: 'origin/main' },
  })
})

test('setup failure is kind setup-failed and the worktree is kept', async () => {
  const io = fakeIo({ ...cloneScript, 'bash -e -c make setup': { code: 3 } }, { files: { '/r/repo/graft.toml': toml } })
  const err = await create(io, { branch: 'foo', setup: true }).catch((e) => e)
  expect(err).toMatchObject({ kind: 'setup-failed' })
  expect(err.message).toContain(wt)
  expect(err.hint).toContain(`graft setup ${wt}`)
  expect(io.calls.some((c) => c[0] === 'git' && c[1] === 'worktree' && c[2] === 'remove')).toBe(false)
})

test('--no-setup skips the hook; collisions get -2; --name sets the folder', async () => {
  const io = fakeIo(cloneScript, { files: { '/r/repo/graft.toml': toml }, paths: [wt] })
  const r = await create(io, { branch: 'foo', setup: false })
  expect(r.worktree).toBe(`${wt}-2`)
  expect(r.setup).toEqual({ ran: false, exit: null })
  expect(io.calls.some((c) => c[0] === 'bash')).toBe(false)

  const named = await create(fakeIo(cloneScript), { branch: 'foo', name: 'Try This', setup: true })
  expect(named.worktree).toBe('/r/repo.worktrees/Try-This')
})

test('an existing branch is refused before anything is fetched', async () => {
  const io = fakeIo({ ...cloneScript, 'git show-ref --verify --quiet refs/heads/foo': { code: 0 } })
  await expect(create(io, { branch: 'foo', setup: true })).rejects.toMatchObject({ kind: 'exists' })
  expect(io.calls.some((c) => c[1] === 'fetch' || c[1] === 'worktree' && c[2] === 'add')).toBe(false)
})

test('--title goes through the repo template; --branch never does', async () => {
  const toml = '[branch]\ntemplate = "{user}/{key}-{slug}"\n'
  const script = { ...cloneScript, 'git check-ref-format --branch alice/fix-login': { out: 'alice/fix-login\n' }, 'git show-ref --verify --quiet refs/heads/alice/fix-login': { code: 1 } }
  const files = { '/r/repo/graft.toml': toml, '/home/me/.config/graft/config.toml': 'user = "alice"\n' }
  const io = fakeIo(script, { files })
  const r = await create(io, { title: 'Fix login', setup: true })
  expect(r).toMatchObject({ branch: 'alice/fix-login', worktree: '/r/repo.worktrees/alice-fix-login', base: 'origin/main' })
  expect(io.calls).toContainEqual(['git', 'worktree', 'add', '--no-track', '-b', 'alice/fix-login', '/r/repo.worktrees/alice-fix-login', 'refs/remotes/origin/main'])

  expect((await create(fakeIo(cloneScript, { files }), { branch: 'foo', setup: true })).branch).toBe('foo')
})

test('sources and bases are checked before anything runs', async () => {
  for (const opts of [{}, { branch: 'a', title: 'b' }, { branch: 'a', base: 'main', from: 'x' }, { remote: 'a', base: 'main' }, { remote: 'a', from: 'x' }]) {
    const io = fakeIo(cloneScript)
    await expect(create(io, { ...opts, setup: true })).rejects.toMatchObject({ kind: 'usage' })
    expect(io.calls).toEqual([])
  }
})

test('--remote: a branch missing locally and on the remote is not-found; no worktree is added', async () => {
  const io = fakeIo({
    ...cloneScript,
    'git check-ref-format --branch nope': { out: 'nope\n' },
    'git show-ref --verify --quiet refs/heads/nope': { code: 1 },
    'git show-ref --verify --quiet refs/remotes/origin/nope': { code: 1 },
  })
  await expect(create(io, { remote: 'nope', setup: true })).rejects.toMatchObject({ kind: 'not-found' })
  expect(io.calls).toContainEqual(['git', 'fetch', '--no-tags', 'origin', '+refs/heads/nope:refs/remotes/origin/nope'])
  expect(io.calls.some((c) => c[1] === 'worktree' && c[2] === 'add')).toBe(false)
})

test('a path git still registers, its folder deleted by hand, counts as taken', async () => {
  const io = fakeIo({
    ...cloneScript,
    'git worktree list --porcelain': { out: `worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/feature/foo\nprunable gitdir file points to non-existent location\n\n` },
  })
  expect((await create(io, { branch: 'foo', setup: false })).worktree).toBe(`${wt}-2`)
})
