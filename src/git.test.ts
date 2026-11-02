import { describe, expect, test } from 'bun:test'
import { checkNewBranch, defaultBranch, parseWorktreeList, pickRemote, resolveBase } from './git.ts'
import { fakeIo } from './test/fake-io.ts'

describe('parseWorktreeList', () => {
  test('main, linked, detached, locked and prunable entries', () => {
    const text = [
      'worktree /r/repo\nHEAD aaa\nbranch refs/heads/main\n',
      'worktree /r/repo.worktrees/foo\nHEAD bbb\nbranch refs/heads/alice/foo\nlocked on a usb disk\n',
      'worktree /r/repo.worktrees/old\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n',
    ].join('\n')
    expect(parseWorktreeList(text)).toEqual([
      { path: '/r/repo', head: 'aaa', branch: 'main', main: true, bare: false, locked: false, prunable: false },
      { path: '/r/repo.worktrees/foo', head: 'bbb', branch: 'alice/foo', main: false, bare: false, locked: true, prunable: false },
      { path: '/r/repo.worktrees/old', head: 'ccc', branch: null, main: false, bare: false, locked: false, prunable: true },
    ])
  })

  test('bare repository and empty output', () => {
    expect(parseWorktreeList('worktree /r/repo.git\nbare\n')[0]).toMatchObject({ bare: true, branch: null, head: null })
    expect(parseWorktreeList('')).toEqual([])
  })
})

describe('pickRemote', () => {
  test('config wins', async () => {
    expect(await pickRemote(fakeIo(), '/r', 'upstream')).toBe('upstream')
  })

  test("current branch's upstream remote", async () => {
    const io = fakeIo({
      'git symbolic-ref --quiet --short HEAD': { out: 'main\n' },
      'git config --get branch.main.remote': { out: 'gitlab\n' },
      'git remote': { out: 'gitlab\norigin\n' },
    })
    expect(await pickRemote(io, '/r')).toBe('gitlab')
  })

  test('the only remote, else origin', async () => {
    const detached = { 'git symbolic-ref --quiet --short HEAD': { code: 1 } }
    expect(await pickRemote(fakeIo({ ...detached, 'git remote': { out: 'forge\n' } }), '/r')).toBe('forge')
    expect(await pickRemote(fakeIo({ ...detached, 'git remote': { out: 'a\nb\n' } }), '/r')).toBe('origin')
    expect(await pickRemote(fakeIo({ ...detached, 'git remote': { out: '' } }), '/r')).toBe('origin')
  })
})

describe('defaultBranch', () => {
  test('from refs/remotes/<remote>/HEAD', async () => {
    const io = fakeIo({ 'git symbolic-ref --quiet refs/remotes/forge/HEAD': { out: 'refs/remotes/forge/trunk\n' } })
    expect(await defaultBranch(io, '/r', 'forge')).toBe('trunk')
  })

  test('asks the remote when the local HEAD ref is missing', async () => {
    const io = fakeIo({
      'git symbolic-ref --quiet refs/remotes/origin/HEAD': { code: 1 },
      'git ls-remote --symref origin HEAD': { out: 'ref: refs/heads/develop\tHEAD\nabc\tHEAD\n' },
    })
    expect(await defaultBranch(io, '/r', 'origin')).toBe('develop')
  })

  test('not-found when neither works', async () => {
    const io = fakeIo({
      'git symbolic-ref --quiet refs/remotes/origin/HEAD': { code: 1 },
      'git ls-remote --symref origin HEAD': { code: 128 },
    })
    await expect(defaultBranch(io, '/r', 'origin')).rejects.toMatchObject({ kind: 'not-found' })
  })
})

describe('resolveBase', () => {
  test('fetches the exact ref and prefers the remote-tracking ref', async () => {
    const io = fakeIo()
    expect(await resolveBase(io, '/r', 'origin', 'main')).toEqual({ name: 'origin/main', ref: 'refs/remotes/origin/main' })
    expect(io.calls[0]).toEqual(['git', 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  })

  test('fetch failure warns and falls back to the local branch', async () => {
    const io = fakeIo({
      'git fetch': { code: 128, err: 'could not resolve host' },
      'git show-ref --verify --quiet refs/remotes/origin/release': { code: 1 },
    })
    expect(await resolveBase(io, '/r', 'origin', 'release')).toEqual({ name: 'release', ref: 'refs/heads/release' })
    expect(io.warnings[0]).toContain('could not fetch release from origin')
  })

  test('refs/heads/<b> picks the local branch, without fetching, even when the remote has one', async () => {
    const io = fakeIo()
    expect(await resolveBase(io, '/r', 'origin', 'refs/heads/release')).toEqual({ name: 'release', ref: 'refs/heads/release' })
    expect(io.calls).toEqual([['git', 'show-ref', '--verify', '--quiet', 'refs/heads/release']])
    await expect(resolveBase(fakeIo({ 'git show-ref': { code: 1 } }), '/r', 'origin', 'refs/heads/nope')).rejects.toMatchObject({ kind: 'not-found' })
  })

  test('not-found when the base exists nowhere', async () => {
    const io = fakeIo({ 'git fetch': { code: 128 }, 'git show-ref': { code: 1 } })
    await expect(resolveBase(io, '/r', 'origin', 'nope')).rejects.toMatchObject({ kind: 'not-found' })
  })

  test('uses the remote default branch when no base is given', async () => {
    const io = fakeIo({ 'git symbolic-ref --quiet refs/remotes/origin/HEAD': { out: 'refs/remotes/origin/main\n' } })
    expect((await resolveBase(io, '/r', 'origin')).name).toBe('origin/main')
  })
})

describe('checkNewBranch', () => {
  test('rejects invalid names and existing branches', async () => {
    await expect(checkNewBranch(fakeIo({ 'git check-ref-format': { code: 1 } }), '/r', 'a..b')).rejects.toMatchObject({ kind: 'usage' })
    const exists = fakeIo({ 'git check-ref-format --branch foo': { out: 'foo\n' } })
    await expect(checkNewBranch(exists, '/r', 'foo')).rejects.toMatchObject({ kind: 'exists' })
  })
})
