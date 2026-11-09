import { afterAll, expect, test } from 'bun:test'
import { existsSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clean } from './commands/clean.ts'
import { remove } from './commands/remove.ts'
import { systemIo } from './io.ts'
import { realRepo } from './test/real-git.ts'

const r = realRepo()
afterAll(r.cleanup)
const opts = { force: false, keepBranch: false, ignoreTeardown: false }

function worktree(branch: string) {
  const path = join(r.dir, branch)
  r.sh(r.repo, 'git', 'worktree', 'add', '-b', branch, path, 'origin/main')
  return path
}

function io() {
  const f = systemIo(r.env, r.repo)
  f.warn = () => {}
  return f
}

test('real teardown leaving an untracked file keeps the checkout and its link', async () => {
  const path = worktree('teardown-dirt')
  const env = join(r.repo, '.env')
  writeFileSync(env, 'test\n')
  symlinkSync(env, join(path, '.env'))
  writeFileSync(join(r.repo, 'graft.toml'), 'link = [".env"]\n[hooks]\nteardown = "touch scratch"\n')
  await expect(remove(io(), { ...opts, worktree: path })).rejects.toMatchObject({ kind: 'dirty' })
  expect(existsSync(join(path, 'scratch'))).toBe(true)
  expect(readlinkSync(join(path, '.env'))).toBe(env)
})

test('real git refusal after unlink restores the link', async () => {
  const path = worktree('removal-race')
  const env = join(r.repo, '.env')
  writeFileSync(env, 'test\n')
  symlinkSync(env, join(path, '.env'))
  writeFileSync(join(r.repo, 'graft.toml'), 'link = [".env"]\n')
  const f = io()
  const run = f.run
  f.run = async (cmd, o) => {
    if (cmd.slice(0, 3).join(' ') === 'git worktree remove') writeFileSync(join(path, 'late-file'), 'keep me\n')
    return run(cmd, o)
  }
  await expect(remove(f, { ...opts, worktree: path })).rejects.toMatchObject({ kind: 'dirty' })
  expect(existsSync(join(path, 'late-file'))).toBe(true)
  expect(readlinkSync(join(path, '.env'))).toBe(env)
})

test('real clean leaves a checkout whose branch advanced during the prompt', async () => {
  const path = worktree('prompt-race')
  r.sh(path, 'git', 'commit', '--allow-empty', '-m', 'merged empty commit')
  writeFileSync(join(r.repo, 'graft.toml'), '')
  const f = io()
  f.isTTY = true
  let asked = false
  f.ask = async () => {
    asked = true
    writeFileSync(join(path, 'new-work'), 'not merged\n')
    r.sh(path, 'git', 'add', 'new-work')
    r.sh(path, 'git', 'commit', '-m', 'new work while confirming')
    return true
  }
  const result = await clean(f, { dryRun: false, yes: false, paths: [path] })
  expect(asked).toBe(true)
  expect(result.skipped).toEqual([{ path, branch: 'prompt-race', reason: 'changed' }])
  expect(existsSync(join(path, 'new-work'))).toBe(true)
})

test('real malformed preserve flag prevents branch deletion', async () => {
  const path = worktree('preserve-invalid')
  r.sh(r.repo, 'git', 'config', 'branch.preserve-invalid.graft-preserve', 'not-a-bool')
  writeFileSync(join(r.repo, 'graft.toml'), '')
  const result = await remove(io(), { ...opts, worktree: path })
  expect(result.branch).toMatchObject({ deleted: false, reason: 'preserved' })
  expect(r.sh(r.repo, 'git', 'rev-parse', '--verify', 'refs/heads/preserve-invalid')).toBeTruthy()
})
