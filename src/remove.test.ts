import { expect, test } from 'bun:test'
import { remove, type RemoveOpts } from './commands/remove.ts'
import { cloneScript, fakeIo, type Reply } from './test/fake-io.ts'

const wt = '/r/repo.worktrees/foo'
const toml = '[hooks]\nteardown = "make down"\n'
const script: Record<string, Reply> = {
  ...cloneScript,
  'git worktree list --porcelain': {
    out: `worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/foo\n\n`,
  },
  'git config --get branch.foo.graft-base': { out: 'refs/remotes/origin/main\n' },
  // Not merged unless a test says otherwise.
  'git merge-base --is-ancestor': { code: 1 },
  'git merge-tree': { code: 1 },
}
const opts: RemoveOpts = { worktree: wt, force: false, keepBranch: false, ignoreTeardown: false }
const files = { '/r/repo/graft.toml': toml }
const io = (extra: Record<string, Reply> = {}) => fakeIo({ ...script, ...extra }, { files, paths: [wt] })
const removedWorktree = (calls: string[][]) => calls.some((c) => c.slice(0, 3).join(' ') === 'git worktree remove')

test('order: dirty check, teardown in the worktree, worktree remove, then the branch check', async () => {
  const f = io()
  const r = await remove(f, opts)
  expect(r).toEqual({
    removed: wt,
    teardown: { ran: true, exit: 0 },
    branch: { name: 'foo', deleted: false, reason: 'not-merged', head: 'bbb' },
  })
  const order = ['git status --porcelain', 'bash -e -c make down', 'git worktree remove', 'git merge-base --is-ancestor bbb']
    .map((p) => f.calls.findIndex((c) => c.join(' ').startsWith(p)))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(f.runs.find((x) => x.cmd[0] === 'bash')!.opts).toMatchObject({ cwd: wt, env: { GRAFT_BRANCH: 'foo', GRAFT_BASE: 'origin/main' } })
  expect(f.calls).toContainEqual(['git', 'worktree', 'remove', wt])
  expect(f.calls.some((c) => c[1] === 'update-ref')).toBe(false)
})

test('failing teardown is teardown-failed and nothing is removed', async () => {
  const f = io({ 'bash -e -c make down': { code: 2 } })
  await expect(remove(f, opts)).rejects.toMatchObject({ kind: 'teardown-failed' })
  expect(removedWorktree(f.calls)).toBe(false)
  expect(f.calls.some((c) => c[1] === 'update-ref')).toBe(false)
})

test('--ignore-teardown proceeds after a failing teardown', async () => {
  const f = io({ 'bash -e -c make down': { code: 2 } })
  const r = await remove(f, { ...opts, ignoreTeardown: true })
  expect(r.teardown).toEqual({ ran: true, exit: 2 })
  expect(f.calls).toContainEqual(['git', 'worktree', 'remove', wt])
})

test('dirty refuses without --force; --force skips the check and forces the removal', async () => {
  const dirty = { 'git status --porcelain': { out: '?? notes.txt\n' } }
  const f = io(dirty)
  await expect(remove(f, opts)).rejects.toMatchObject({ kind: 'dirty' })
  expect(f.calls.some((c) => c[0] === 'bash')).toBe(false)
  expect(removedWorktree(f.calls)).toBe(false)

  const forced = io(dirty)
  await remove(forced, { ...opts, force: true })
  expect(forced.calls).toContainEqual(['git', 'worktree', 'remove', '--force', wt])
})

test('initialized submodules count as dirty', async () => {
  const f = io({ 'git submodule status': { out: ' 1234abc lib/dep (heads/main)\n' } })
  await expect(remove(f, opts)).rejects.toMatchObject({ kind: 'dirty' })
})

test('main checkout and locked worktrees are refused, even with --force', async () => {
  await expect(remove(io(), { ...opts, worktree: '/r/repo', force: true })).rejects.toMatchObject({ kind: 'usage' })
  const locked = io({
    'git worktree list --porcelain': { out: `worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbb\nbranch refs/heads/foo\nlocked\n\n` },
  })
  await expect(remove(locked, { ...opts, force: true })).rejects.toMatchObject({ kind: 'locked' })
  expect(removedWorktree(locked.calls)).toBe(false)
})

test('a merged branch is deleted with compare-and-delete; by branch name works too', async () => {
  const f = io({ 'git merge-base --is-ancestor bbb refs/remotes/origin/main': { code: 0 } })
  const r = await remove(f, { ...opts, worktree: 'foo' })
  expect(r.branch).toEqual({ name: 'foo', deleted: true, head: 'bbb' })
  expect(f.calls).toContainEqual(['git', 'update-ref', '-d', 'refs/heads/foo', 'bbb'])
  expect(f.calls).toContainEqual(['git', 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
})

test('a squash merge is proven by merge-tree == target tree', async () => {
  const f = io({
    'git rev-parse --verify --quiet refs/remotes/origin/main^{tree}': { out: 'tree1\n' },
    'git merge-tree --write-tree refs/remotes/origin/main bbb': { out: 'tree1\n' },
  })
  expect((await remove(f, opts)).branch).toMatchObject({ deleted: true })
})

test('--keep-branch and graft-preserve keep a merged branch', async () => {
  const merged = { 'git merge-base --is-ancestor': { code: 0 } }
  expect((await remove(io(merged), { ...opts, keepBranch: true })).branch).toMatchObject({ deleted: false, reason: 'kept' })
  const preserved = io({ ...merged, 'git config --type=bool --get branch.foo.graft-preserve': { out: 'true\n' } })
  expect((await remove(preserved, opts)).branch).toMatchObject({ deleted: false, reason: 'preserved' })
  expect(preserved.calls.some((c) => c[1] === 'update-ref')).toBe(false)
})

test("graft's own symlinks are not dirt, and are unlinked before git worktree remove", async () => {
  const f = fakeIo(
    { ...script, 'git status --porcelain': { out: '?? .env.local\0' } },
    {
      files: { '/r/repo/graft.toml': 'link = [".env.local", "notes.txt"]\n' },
      paths: [wt],
      links: { [`${wt}/.env.local`]: '/r/repo/.env.local' },
    },
  )
  await remove(f, opts)
  const rm = f.calls.findIndex((c) => c.join(' ') === `rm -- ${wt}/.env.local`)
  const wtRemove = f.calls.findIndex((c) => c.slice(0, 3).join(' ') === 'git worktree remove')
  expect(rm).toBeGreaterThanOrEqual(0)
  expect(rm).toBeLessThan(wtRemove)

  // Any other untracked file still counts.
  const dirty = fakeIo(
    { ...script, 'git status --porcelain': { out: '?? .env.local\0?? notes.txt\0' } },
    { files: { '/r/repo/graft.toml': 'link = [".env.local", "notes.txt"]\n' }, paths: [wt], links: { [`${wt}/.env.local`]: '/r/repo/.env.local' } },
  )
  await expect(remove(dirty, opts)).rejects.toMatchObject({ kind: 'dirty' })
})

test('the Herdr space graft runs in closes last, after the worktree and branch are settled', async () => {
  const space = (id: string, terminal: string) => ({ id, folder: wt, tabs: [{ id: `${id}-tab`, name: 'shell', terminals: [{ terminal, status: 'idle' }] }] })
  const f = fakeIo(
    { ...script, 'herdr-app ls': { out: JSON.stringify({ spaces: [space('own', 't1'), space('other', 't2')] }) } },
    { files, paths: [wt], env: { HC_TERMINAL_ID: 't1' } },
  )
  await remove(f, opts)
  const at = (p: string) => f.calls.findIndex((c) => c.join(' ').startsWith(p))
  expect(at('herdr-app do space.close {"id":"other"')).toBeLessThan(at('git worktree remove'))
  expect(at('herdr-app do space.close {"id":"own"')).toBeGreaterThan(at('git merge-base --is-ancestor bbb'))
})

test('a worktree with another worktree inside is refused, so git does not delete the nested one', async () => {
  const nested = `${wt}/inner`
  const f = fakeIo(
    { ...script, 'git worktree list --porcelain': { out: `${script['git worktree list --porcelain']!.out}worktree ${nested}\nHEAD ccc\nbranch refs/heads/inner\n\n` } },
    { files, paths: [wt, nested] },
  )
  expect(await remove(f, opts).catch((e) => e)).toMatchObject({ kind: 'usage' })
  expect(removedWorktree(f.calls)).toBe(false)
})

test('a branch name wins over another worktree whose folder has that name', async () => {
  const first = '/r/repo.worktrees/feature-foo'
  const second = '/r/repo.worktrees/feature-foo-2'
  const f = fakeIo({
    ...script,
    'git worktree list --porcelain': {
      out: `worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${first}\nHEAD b1\nbranch refs/heads/feature/foo\n\nworktree ${second}\nHEAD b2\nbranch refs/heads/feature-foo\n\n`,
    },
  }, { files, paths: [first, second] })
  expect((await remove(f, { ...opts, worktree: 'feature-foo' })).removed).toBe(second)
})
