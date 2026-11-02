import { GraftError } from '../errors.ts'
import type { Io } from '../io.ts'

export const repo = 'gecm0/graft'

export type UpdateOpts = {
  version: string
  // The running binary, or null when Bun runs the TypeScript (then process.execPath is bun itself).
  exec: string | null
  os: string
  arch: string
}

export type UpdateResult = { path: string | null; from: string; to: string; updated: boolean }

// graft update: if the latest GitHub release is newer, downloads its graft-<os>-<arch> asset next
// to the running binary, signs it ad hoc on macOS, checks that it runs, then renames it over the
// binary (same folder, so the rename is atomic).
export async function update(io: Io, opts: UpdateOpts): Promise<UpdateResult> {
  if (!opts.exec) throw new GraftError('unsupported', 'graft update only updates the compiled binary', 'this graft runs from source (bun link): git pull instead')
  const res = await get(io, `https://api.github.com/repos/${repo}/releases/latest`)
  const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  const to = release.tag_name.replace(/^v/, '')
  const result = { path: opts.exec, from: opts.version, to, updated: false }
  if (Bun.semver.order(to, opts.version) <= 0) return result

  const name = `graft-${opts.os}-${opts.arch}`
  const asset = release.assets.find((a) => a.name === name)
  if (!asset) throw new GraftError('unsupported', `release ${release.tag_name} has no ${name} binary`, `see https://github.com/${repo}/releases`)
  // Per process, so two concurrent updates never validate or delete each other's download.
  const tmp = `${opts.exec}.update-${process.pid}`
  const bytes = new Uint8Array(await (await get(io, asset.browser_download_url)).arrayBuffer())
  try {
    // Inside the try: a write that fails half way (disk full) still leaves no partial binary behind.
    await io.writeText(tmp, bytes)
    await must(io, ['chmod', '755', tmp])
    if (opts.os === 'darwin') await must(io, ['codesign', '-s', '-', '-f', tmp])
    await must(io, [tmp, '--version'])
    await must(io, ['mv', '-f', tmp, opts.exec])
  } catch (e) {
    await io.run(['rm', '-f', tmp])
    throw e
  }
  return { ...result, updated: true }
}

async function get(io: Io, url: string): Promise<Response> {
  let res: Response
  try {
    res = await io.fetch(url, { headers: { 'user-agent': 'graft' } })
  } catch (e) {
    throw new GraftError('network', `could not reach ${url}: ${(e as Error).message}`)
  }
  if (!res.ok) throw new GraftError('network', `${url}: HTTP ${res.status}`)
  return res
}

async function must(io: Io, cmd: string[]): Promise<void> {
  const r = await io.run(cmd)
  if (r.code !== 0) throw new GraftError('unsupported', `${cmd.join(' ')} failed: ${r.err.trim() || `exit ${r.code}`}`, 'the installed binary was left as it was')
}
