import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A temp dir with a bare "origin" (HEAD -> main), one commit on main, and a clone of it.
// The host's git config can't leak in: global points at an empty file, system is off.
// A failing herdr-app stub comes first on PATH, so these tests never see the host's spaces and show
// graft works without Herdr (dropping its folder from PATH could drop git or bun with it).
export function realRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'graft-test-')))
  const gitconfig = join(dir, 'gitconfig')
  writeFileSync(gitconfig, '')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'herdr-app'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  }
  const sh = (cwd: string, ...cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  const repo = join(dir, 'repo')
  sh(dir, 'git', 'init', '--bare', '-b', 'main', origin)
  sh(dir, 'git', 'init', '-b', 'main', seed)
  writeFileSync(join(seed, 'README'), 'hello\n')
  sh(seed, 'git', 'add', '.')
  sh(seed, 'git', 'commit', '-m', 'init')
  sh(seed, 'git', 'push', origin, 'main')
  sh(dir, 'git', 'clone', origin, repo)
  return { dir, origin, seed, repo, env, sh, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
