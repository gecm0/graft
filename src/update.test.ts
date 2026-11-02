import { expect, test } from 'bun:test'
import { update } from './commands/update.ts'
import { fakeIo } from './test/fake-io.ts'

const exec = '/home/me/.local/bin/graft'
const tmp = `${exec}.update-${process.pid}`
const asset = 'https://github.com/gecm0/graft/releases/download/v0.2.0/graft-darwin-arm64'

// A fake GitHub: the latest release is `tag`, with darwin-arm64 and linux-x64 binaries.
function github(tag: string) {
  const fetched: string[] = []
  const fetch = async (url: string) => {
    fetched.push(url)
    if (url.endsWith('/releases/latest')) {
      const assets = ['darwin-arm64', 'linux-x64'].map((p) => ({ name: `graft-${p}`, browser_download_url: `https://github.com/gecm0/graft/releases/download/${tag}/graft-${p}` }))
      return Response.json({ tag_name: tag, assets })
    }
    return new Response('new binary')
  }
  return { fetch, fetched }
}

test('downloads a newer release, signs it, checks it runs, then renames it over the binary', async () => {
  const gh = github('v0.2.0')
  const io = fakeIo({}, { fetch: gh.fetch })
  const r = await update(io, { version: '0.1.0', exec, os: 'darwin', arch: 'arm64' })
  expect(r).toEqual({ path: exec, from: '0.1.0', to: '0.2.0', updated: true })
  expect(gh.fetched).toEqual(['https://api.github.com/repos/gecm0/graft/releases/latest', asset])
  expect(await io.readText(tmp)).toBe('new binary')
  expect(io.calls).toEqual([
    ['chmod', '755', tmp],
    ['codesign', '-s', '-', '-f', tmp],
    [tmp, '--version'],
    ['mv', '-f', tmp, exec],
  ])
})

test('no codesign on Linux', async () => {
  const io = fakeIo({}, { fetch: github('v0.2.0').fetch })
  await update(io, { version: '0.1.0', exec, os: 'linux', arch: 'x64' })
  expect(io.calls.map((c) => c[0])).toEqual(['chmod', tmp, 'mv'])
})

test('same or older release: nothing downloaded', async () => {
  for (const [tag, version] of [['v0.1.0', '0.1.0'], ['v0.9.0', '0.10.0']]) {
    const gh = github(tag!)
    const io = fakeIo({}, { fetch: gh.fetch })
    expect((await update(io, { version: version!, exec, os: 'darwin', arch: 'arm64' })).updated).toBe(false)
    expect(gh.fetched).toHaveLength(1)
    expect(io.calls).toEqual([])
  }
})

test('a new binary that fails to run is deleted and the old one kept', async () => {
  const io = fakeIo({ [`${tmp} --version`]: { code: 137 } }, { fetch: github('v0.2.0').fetch })
  await expect(update(io, { version: '0.1.0', exec, os: 'darwin', arch: 'arm64' })).rejects.toMatchObject({ kind: 'unsupported' })
  expect(io.calls.at(-1)).toEqual(['rm', '-f', tmp])
  expect(io.calls.map((c) => c[0])).not.toContain('mv')
})

test('refuses from source, without a binary for this platform, and offline', async () => {
  const gh = github('v0.2.0')
  await expect(update(fakeIo({}, { fetch: gh.fetch }), { version: '0.1.0', exec: null, os: 'darwin', arch: 'arm64' })).rejects.toMatchObject({ kind: 'unsupported' })
  expect(gh.fetched).toEqual([])
  await expect(update(fakeIo({}, { fetch: gh.fetch }), { version: '0.1.0', exec, os: 'linux', arch: 'arm64' })).rejects.toMatchObject({ kind: 'unsupported' })
  await expect(update(fakeIo(), { version: '0.1.0', exec, os: 'darwin', arch: 'arm64' })).rejects.toMatchObject({ kind: 'network' })
})

test('a download that fails to write is cleaned up', async () => {
  const io = fakeIo({}, { fetch: github('v0.2.0').fetch })
  io.writeText = async () => {
    throw new Error('ENOSPC')
  }
  await expect(update(io, { version: '0.1.0', exec, os: 'darwin', arch: 'arm64' })).rejects.toThrow('ENOSPC')
  expect(io.calls).toEqual([['rm', '-f', tmp]])
})
