import { describe, expect, test } from 'bun:test'
import { copyIncludes, linkPaths, parseWorktreeInclude, safeRel, unlinkLinks } from './materialize.ts'
import { fakeIo } from './test/fake-io.ts'

const main = '/r/repo'
const wt = '/r/repo.worktrees/foo'

describe('safeRel', () => {
  test('normalizes and rejects escapes', () => {
    expect(safeRel('./apps/web/.env.local')).toBe('apps/web/.env.local')
    expect(safeRel('.claude/')).toBe('.claude')
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'C:\\x', '', '.']) expect(safeRel(bad)).toBeNull()
  })
})

describe('parseWorktreeInclude', () => {
  test('comments, blanks, ./ and trailing / kept for safeRel; globs and negation warned', () => {
    const warnings: string[] = []
    const text = '# copies\n\n.env.local\n./certs/\n*.pem\n!keep\n  data/seed.sql  \n'
    expect(parseWorktreeInclude(text, (m) => warnings.push(m))).toEqual(['.env.local', './certs/', 'data/seed.sql'])
    expect(warnings).toHaveLength(2)
  })
})

describe('linkPaths', () => {
  test('a repeated entry is linked once, and nothing is written through a symlinked folder of the branch', async () => {
    const io = fakeIo(
      { 'git -c core.quotePath=false check-ignore': { code: 0, out: 'certs\n' } },
      { paths: [`${main}/certs`, `${main}/apps/api/.env`], links: { [`${wt}/apps/api`]: '/tmp/shared' } },
    )
    const r = await linkPaths(io, main, wt, ['certs', './certs/', 'apps/api/.env'])
    expect(r.linked).toEqual(['certs'])
    expect(r.skipped).toEqual([{ path: 'apps/api/.env', reason: 'invalid' }])
    expect(io.calls.filter((c) => c[0] === 'ln')).toHaveLength(1)
  })

  test('links gitignored sources; skips invalid, missing, existing (even broken links) and tracked', async () => {
    const io = fakeIo(
      { 'git -c core.quotePath=false check-ignore': { code: 0, out: '.env.local\napps/web/.env.local\n' } },
      {
        paths: [`${main}/.env.local`, `${main}/apps/web/.env.local`, `${main}/README`, `${main}/taken`, `${wt}/taken`, `${main}/dangling`],
        links: { [`${wt}/dangling`]: '/nowhere' },
      },
    )
    const r = await linkPaths(io, main, wt, ['.env.local', 'apps/web/.env.local', '../up', 'gone', 'taken', 'dangling', 'README'])
    expect(r.linked).toEqual(['.env.local', 'apps/web/.env.local'])
    expect(r.skipped).toEqual([
      { path: '../up', reason: 'invalid' },
      { path: 'gone', reason: 'missing' },
      { path: 'taken', reason: 'exists' },
      { path: 'dangling', reason: 'exists' },
      { path: 'README', reason: 'not-ignored' },
    ])
    expect(io.calls).toContainEqual(['git', '-c', 'core.quotePath=false', 'check-ignore', '--', '.env.local', 'apps/web/.env.local', 'README'])
    expect(io.runs.find((x) => x.cmd[3] === 'check-ignore')!.opts.cwd).toBe(main)
    expect(io.calls).toContainEqual(['mkdir', '-p', `${wt}/apps/web`])
    expect(io.calls).toContainEqual(['ln', '-s', '--', `${main}/apps/web/.env.local`, `${wt}/apps/web/.env.local`])
    expect(io.calls.some((c) => c[0] === 'ln' && c.includes(`${wt}/README`))).toBe(false)
  })

  test("graft's own earlier link counts as linked and is not redone", async () => {
    const io = fakeIo({}, { paths: [`${main}/.env.local`, `${wt}/.env.local`], links: { [`${wt}/.env.local`]: `${main}/.env.local` } })
    expect(await linkPaths(io, main, wt, ['.env.local'])).toEqual({ linked: ['.env.local'], copied: [], skipped: [] })
    expect(io.calls).toEqual([])
  })

  test('a failing check-ignore skips everything without throwing', async () => {
    const io = fakeIo({ 'git -c core.quotePath=false check-ignore': { code: 128, err: 'fatal' } }, { paths: [`${main}/.env.local`] })
    expect((await linkPaths(io, main, wt, ['.env.local'])).skipped).toEqual([{ path: '.env.local', reason: 'error' }])
    expect(io.warnings.join()).toContain('check-ignore failed')
  })
})

describe('copyIncludes', () => {
  const files = { [`${main}/.worktreeinclude`]: 'certs\nbig\n' }
  const paths = [`${main}/certs`, `${main}/big`]
  const ignored = { 'git -c core.quotePath=false check-ignore': { out: 'certs\nbig\n' } }

  test('copies what .worktreeinclude lists, within the budget', async () => {
    const io = fakeIo({ ...ignored, [`du -H -l -sk ${main}/big`]: { out: `${3 * 1024 * 1024}\t${main}/big\n` } }, { files, paths })
    const r = await copyIncludes(io, main, wt)
    expect(r.copied).toEqual(['certs'])
    expect(r.skipped).toEqual([{ path: 'big', reason: 'too-large' }])
    expect(io.calls.some((c) => c[0] === 'cp' && c.includes(`${main}/certs`) && c.includes(`${wt}/certs`))).toBe(true)
    expect(io.calls.some((c) => c[0] === 'cp' && c.includes(`${main}/big`))).toBe(false)
  })

  test('the entry count is capped too', async () => {
    const many = Array.from({ length: 50_001 }, (_, i) => `f${i}`).join('\n')
    const io = fakeIo({ ...ignored, [`find -H ${main}/certs`]: { out: many } }, { files, paths })
    expect((await copyIncludes(io, main, wt)).skipped).toContainEqual({ path: 'certs', reason: 'too-large' })
  })

  test('no .worktreeinclude, nothing to do', async () => {
    const io = fakeIo()
    expect(await copyIncludes(io, main, wt)).toEqual({ linked: [], copied: [], skipped: [] })
    expect(io.calls).toEqual([])
  })
})

test('unlinkLinks removes only symlinks that point into the main checkout', async () => {
  const io = fakeIo({}, {
    links: { [`${wt}/.env.local`]: `${main}/.env.local`, [`${wt}/.claude`]: '../elsewhere' },
  })
  await unlinkLinks(io, main, wt, ['.env.local', '.claude', 'real-file'])
  expect(io.calls).toEqual([['rm', '--', `${wt}/.env.local`]])
})
