import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realRepo } from './test/real-git.ts'

const cli = join(import.meta.dir, 'cli.ts')
const r = realRepo()
afterAll(r.cleanup)

function graft(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['bun', cli, ...args], { cwd, env: r.env, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('link and .worktreeinclude (real git)', () => {
  const wt = join(r.dir, 'repo.worktrees', 'foo')
  const main = (rel: string) => join(r.repo, rel)

  test('create links and copies gitignored files and reports the rest', () => {
    // The branch only ignores certs/; .env.local and .claude/ are ignored in main's working tree alone,
    // so in the worktree graft's links show up as untracked and only graft's own filter keeps it clean.
    writeFileSync(main('.gitignore'), 'certs/\n')
    r.sh(r.repo, 'git', 'add', '.gitignore')
    r.sh(r.repo, 'git', 'commit', '-m', 'ignore certs')
    r.sh(r.repo, 'git', 'push', 'origin', 'main')
    appendFileSync(main('.gitignore'), '.env.local\n.claude/\n')

    writeFileSync(main('.env.local'), 'SECRET=1\n')
    writeFileSync(main('notes.txt'), 'untracked, not ignored\n')
    mkdirSync(main('.claude'))
    writeFileSync(main('.claude/settings.local.json'), '{}\n')
    mkdirSync(main('certs'))
    writeFileSync(main('certs/dev.pem'), 'pem\n')
    writeFileSync(main('.worktreeinclude'), '# private copies\ncerts/\n.env.local\n')
    writeFileSync(main('graft.toml'), 'link = [".env.local", ".claude/settings.local.json", "missing.local", "notes.txt"]\n')

    const res = graft(r.repo, 'create', '--branch', 'foo', '--no-setup', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out).files).toEqual({
      linked: ['.env.local', '.claude/settings.local.json'],
      copied: ['certs'],
      skipped: [
        { path: 'missing.local', reason: 'missing' },
        { path: 'notes.txt', reason: 'not-ignored' },
        { path: '.env.local', reason: 'exists' }, // in both lists: the link wins
      ],
    })
    expect(readlinkSync(join(wt, '.env.local'))).toBe(main('.env.local'))
    expect(readlinkSync(join(wt, '.claude/settings.local.json'))).toBe(main('.claude/settings.local.json'))
    expect(lstatSync(join(wt, 'certs/dev.pem')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(wt, 'certs/dev.pem'), 'utf8')).toBe('pem\n')
  })

  test('the links make the worktree count as clean', () => {
    expect(r.sh(wt, 'git', 'status', '--porcelain')).toContain('?? .env.local')
    expect(JSON.parse(graft(r.repo, 'status', 'foo', '--json').out).dirty).toBe(false)
    expect(JSON.parse(graft(r.repo, 'list', '--json').out).find((w: { branch: string }) => w.branch === 'foo').dirty).toBe(false)
  })

  test('graft setup brings back a missing link', () => {
    rmSync(join(wt, '.env.local'))
    const res = graft(wt, 'setup', '--json')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.out).files.linked.sort()).toEqual(['.claude/settings.local.json', '.env.local'])
    expect(readlinkSync(join(wt, '.env.local'))).toBe(main('.env.local'))
  })

  test('remove succeeds without --force and leaves the main checkout files intact', () => {
    const res = graft(r.repo, 'remove', 'foo', '--json')
    expect(res.code).toBe(0)
    expect(existsSync(wt)).toBe(false)
    expect(readFileSync(main('.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(main('.claude/settings.local.json'), 'utf8')).toBe('{}\n')
    expect(readFileSync(main('certs/dev.pem'), 'utf8')).toBe('pem\n')
  })
})

test('a nested link after its parent is skipped, not written through the parent link into main (real fs)', async () => {
  const { linkPaths } = await import('./materialize.ts')
  const { systemIo } = await import('./io.ts')
  const main = join(r.dir, 'nest-main')
  const wt = join(r.dir, 'nest-wt')
  mkdirSync(join(main, 'certs/dev'), { recursive: true })
  mkdirSync(wt)
  writeFileSync(join(main, '.gitignore'), 'certs/\n')
  r.sh(main, 'git', 'init', '-q')
  const files = await linkPaths(systemIo(r.env, main), main, wt, ['certs', 'certs/dev'])
  expect(files.linked).toEqual(['certs'])
  expect(files.skipped).toEqual([{ path: 'certs/dev', reason: 'invalid' }])
  expect(existsSync(join(main, 'certs/dev/dev'))).toBe(false)
})
