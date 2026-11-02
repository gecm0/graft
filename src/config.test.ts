import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRepoConfig, parseRepoConfig } from './config.ts'
import { fakeIo } from './test/fake-io.ts'

const examples = join(import.meta.dir, '..', 'examples')
const userConfig = '/home/me/.config/graft/config.toml'

describe('examples', () => {
  const files = readdirSync(examples).filter((f) => f.endsWith('.toml'))
  test('there are examples', () => expect(files.length).toBeGreaterThan(0))
  for (const file of files) {
    test(`parses ${file} without warnings`, () => {
      const io = fakeIo()
      const cfg = parseRepoConfig(io, Bun.TOML.parse(readFileSync(join(examples, file), 'utf8')) as Record<string, unknown>, file)
      expect(cfg.hooks.setup).toBeTruthy()
      expect(io.warnings).toEqual([])
    })
  }
})

describe('loadRepoConfig', () => {
  const repoToml = '[hooks]\nsetup = "from repo"\n'
  const userToml = '[repos."~/code/repo"]\nlink = [".env"]\n[repos."~/code/repo".hooks]\nsetup = "from user"\n'

  test('repo graft.toml is used', async () => {
    const io = fakeIo({}, { files: { '/home/me/code/repo/graft.toml': repoToml } })
    expect((await loadRepoConfig(io, '/home/me/code/repo')).hooks.setup).toBe('from repo')
    expect(io.warnings).toEqual([])
  })

  test("user config's [repos.<path>] is used when the repo has none", async () => {
    const io = fakeIo({}, { files: { [userConfig]: userToml } })
    const cfg = await loadRepoConfig(io, '/home/me/code/repo')
    expect(cfg).toMatchObject({ hooks: { setup: 'from user' }, link: ['.env'] })
  })

  test('both exist: repo wins, never merged, with a warning', async () => {
    const io = fakeIo({}, { files: { [userConfig]: userToml, '/home/me/code/repo/graft.toml': repoToml } })
    const cfg = await loadRepoConfig(io, '/home/me/code/repo')
    expect(cfg.hooks.setup).toBe('from repo')
    expect(cfg.link).toEqual([])
    expect(io.warnings.join('\n')).toContain('is ignored')
  })

  test('XDG_CONFIG_HOME moves the user config', async () => {
    const io = fakeIo({}, { env: { XDG_CONFIG_HOME: '/xdg' }, files: { '/xdg/graft/config.toml': userToml } })
    expect((await loadRepoConfig(io, '/home/me/code/repo')).hooks.setup).toBe('from user')
  })

  test('no config at all gives empty defaults', async () => {
    expect(await loadRepoConfig(fakeIo(), '/r/repo')).toEqual({
      remote: undefined, link: [], hooks: { setup: undefined, teardown: undefined }, branch: { template: undefined }, tabs: [], agent: undefined,
    })
  })

  test('wrong types are usage errors, unknown keys warn', async () => {
    const io = fakeIo({}, { files: { '/r/repo/graft.toml': '[hooks]\nsetup = 1\n' } })
    await expect(loadRepoConfig(io, '/r/repo')).rejects.toMatchObject({ kind: 'usage' })
    const typo = fakeIo({}, { files: { '/r/repo/graft.toml': '[hook]\nsetup = "x"\n' } })
    await loadRepoConfig(typo, '/r/repo')
    expect(typo.warnings.join('\n')).toContain('unknown key "hook"')
    const nested = fakeIo({}, { files: { '/r/repo/graft.toml': '[hooks]\nsetpu = "x"\n[branch]\ntemplat = "x"\n[agent]\ncmd = ["x"]\n[[tabs]]\ntitle = "t"\ncomand = "x"\n' } })
    await loadRepoConfig(nested, '/r/repo')
    expect(nested.warnings.map((w) => w.match(/"(\w+)"/)?.[1])).toEqual(['setpu', 'templat', 'comand', 'cmd'])
  })

  test('invalid TOML is a usage error', async () => {
    const io = fakeIo({}, { files: { '/r/repo/graft.toml': 'hooks = [' } })
    await expect(loadRepoConfig(io, '/r/repo')).rejects.toMatchObject({ kind: 'usage' })
  })
})
