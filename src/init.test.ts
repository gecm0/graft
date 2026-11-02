import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { init, template } from './commands/init.ts'
import { loadUserConfig } from './config.ts'
import { systemIo } from './io.ts'

test('init creates a private, all-commented user config and never overwrites it', async () => {
  const xdg = mkdtempSync(join(tmpdir(), 'graft-init-'))
  const io = systemIo({ ...process.env, XDG_CONFIG_HOME: xdg })
  const warnings: string[] = []
  io.warn = (m) => warnings.push(m)
  const path = join(xdg, 'graft', 'config.toml')

  expect(await init(io)).toEqual({ path, created: true })
  expect(readFileSync(path, 'utf8')).toBe(template)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(await loadUserConfig(io)).toEqual({ repos: {} })
  expect(warnings).toEqual([])

  writeFileSync(path, 'user = "bob"\n', { mode: 0o644 })
  expect(await init(io)).toEqual({ path, created: false })
  expect(readFileSync(path, 'utf8')).toBe('user = "bob"\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('every example in the template parses once uncommented', async () => {
  const xdg = mkdtempSync(join(tmpdir(), 'graft-init-'))
  const io = systemIo({ ...process.env, XDG_CONFIG_HOME: xdg })
  const warnings: string[] = []
  io.warn = (m) => warnings.push(m)
  await init(io)
  const path = join(xdg, 'graft', 'config.toml')
  const uncommented = template.split('\n').filter((l) => /^# ([a-z_]+ = |\[)/.test(l)).map((l) => l.slice(2)).join('\n')
  writeFileSync(path, uncommented, { mode: 0o600 })
  const cfg = await loadUserConfig(io)
  expect(cfg.user).toBe('alice')
  expect(cfg.linear?.api_key).toBe('lin_api_...')
  expect(cfg.jira?.site).toBe('acme.atlassian.net')
  expect(Object.keys(cfg.repos)).toHaveLength(1)
  expect(warnings).toEqual([])
})
