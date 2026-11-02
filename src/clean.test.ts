import { expect, test } from 'bun:test'
import { clean } from './commands/clean.ts'
import { cloneScript, fakeIo, type Reply } from './test/fake-io.ts'

const w = (name: string) => `/r/repo.worktrees/${name}`
const block = (path: string, head: string, branch: string, extra = '') => `worktree ${path}\nHEAD ${head}\nbranch refs/heads/${branch}\n${extra}\n`
const script: Record<string, Reply> = {
  ...cloneScript,
  'git worktree list --porcelain': {
    out: [
      block('/r/repo', 'aaa', 'main'),
      block(w('a'), 'a1', 'a'),
      block(w('open'), 'o1', 'open'),
      block(w('a/nested'), 'n1', 'nested'),
      block(w('locked'), 'l1', 'locked', 'locked\n'),
      block(w('gone'), 'g1', 'gone', 'prunable gitdir file points to non-existent location\n'),
    ].join('\n'),
  },
  // Only a and nested are merged.
  'git merge-base --is-ancestor': { code: 1 },
  'git merge-tree': { code: 1 },
  'git merge-base --is-ancestor a1': { code: 0 },
  'git merge-base --is-ancestor n1': { code: 0 },
}
const paths = [w('a'), w('open'), w('a/nested'), w('locked')]
const io = (extra: Record<string, Reply> = {}, opts: { tty?: boolean; answer?: boolean } = {}) => fakeIo({ ...script, ...extra }, { paths, ...opts })
const removals = (calls: string[][]) => calls.filter((c) => c.slice(0, 3).join(' ') === 'git worktree remove').map((c) => c.at(-1))
const candidates = [{ path: w('a/nested'), branch: 'nested' }, { path: w('a'), branch: 'a' }]

test('without a terminal or --yes it is a dry run: candidates deepest first, the rest skipped with a reason', async () => {
  const f = io()
  const r = await clean(f, { dryRun: false, yes: false })
  expect(r).toEqual({
    dryRun: true,
    candidates,
    removed: [],
    skipped: [
      { path: w('open'), branch: 'open', reason: 'not-merged' },
      { path: w('locked'), branch: 'locked', reason: 'locked' },
      { path: w('gone'), branch: 'gone', reason: 'prunable' },
    ],
    failed: [],
  })
  expect(removals(f.calls)).toEqual([])
  expect(f.questions).toEqual([])
  // One fetch of the default branch, not one per worktree.
  expect(f.calls.filter((c) => c[1] === 'fetch')).toEqual([['git', 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']])
})

test('--dry-run wins over --yes', async () => {
  const f = io()
  expect((await clean(f, { dryRun: true, yes: true })).dryRun).toBe(true)
  expect(removals(f.calls)).toEqual([])
})

test('--yes removes deepest first', async () => {
  const f = io()
  const r = await clean(f, { dryRun: false, yes: true })
  expect(removals(f.calls)).toEqual([w('a/nested'), w('a')])
  expect(r.dryRun).toBe(false)
  expect(r.failed).toEqual([])
  expect(f.calls).toContainEqual(['git', 'update-ref', '-d', 'refs/heads/a', 'a1'])
})

test('a worktree whose nested worktree failed to go stays, so the nested one is not deleted with it', async () => {
  const f = io({ [`git worktree remove ${w('a/nested')}`]: { code: 1, err: 'boom' } })
  const r = await clean(f, { dryRun: false, yes: true })
  expect(removals(f.calls)).toEqual([w('a/nested')])
  expect(r.removed).toEqual([])
  expect(r.failed).toEqual([
    { path: w('a/nested'), branch: 'nested', error: expect.objectContaining({ kind: 'dirty' }) },
    { path: w('a'), branch: 'a', error: expect.objectContaining({ kind: 'usage' }) },
  ])
})

test('on a terminal it asks once; no removes nothing, yes removes all', async () => {
  const no = io({}, { tty: true, answer: false })
  expect(await clean(no, { dryRun: false, yes: false })).toMatchObject({ dryRun: true, candidates, removed: [] })
  expect(no.questions).toHaveLength(1)
  expect(no.questions[0]).toContain(w('a/nested'))
  expect(removals(no.calls)).toEqual([])

  const yes = io({}, { tty: true, answer: true })
  expect((await clean(yes, { dryRun: false, yes: false })).removed.map((x) => x.path)).toEqual([w('a/nested'), w('a')])
})

test('a branch with no commits of its own (one reflog entry) is skipped, unless preserved', async () => {
  const fresh = { 'git reflog show --format=%H refs/heads/a': { out: 'a1\n' }, 'git reflog show --format=%H refs/heads/nested': { out: 'n1\nb0\n' } }
  const r = await clean(io(fresh), { dryRun: true, yes: false })
  expect(r.candidates).toEqual([{ path: w('a/nested'), branch: 'nested' }])
  expect(r.skipped).toContainEqual({ path: w('a'), branch: 'a', reason: 'no-commits' })

  const preserved = io({ ...fresh, 'git config --type=bool --get branch.a.graft-preserve': { out: 'true\n' } })
  expect((await clean(preserved, { dryRun: true, yes: false })).candidates).toEqual(candidates)
})

test('a base recorded on another remote is fetched from that remote', async () => {
  const f = io({ 'git remote': { out: 'origin\nupstream\n' }, 'git config --get branch.a.graft-base': { out: 'refs/remotes/upstream/release\n' } })
  await clean(f, { dryRun: true, yes: false })
  expect(f.calls).toContainEqual(['git', 'fetch', '--no-tags', 'upstream', '+refs/heads/release:refs/remotes/upstream/release'])
})

test('initialized submodules are skipped up front: remove would refuse them on every run', async () => {
  const r = await clean(io({ 'git submodule status': { out: ' abc123 vendor/lib (heads/main)\n' } }), { dryRun: true, yes: false })
  expect(r.candidates).toEqual([])
  expect(r.skipped.filter((s) => s.reason === 'submodules').map((s) => s.path).sort()).toEqual([w('a'), w('a/nested')])
})

test('with paths only those are considered, each checked again; an unknown path is not-found', async () => {
  const f = io()
  const r = await clean(f, { dryRun: false, yes: true, paths: [w('a/nested'), w('open'), w('nope')] })
  expect(removals(f.calls)).toEqual([w('a/nested')])
  expect(r.skipped).toEqual([
    { path: w('nope'), branch: null, reason: 'not-found' },
    { path: w('open'), branch: 'open', reason: 'not-merged' },
  ])
})
