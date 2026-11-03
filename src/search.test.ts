import { expect, test } from 'bun:test'
import { search } from './commands/search.ts'
import { cloneScript, fakeIo } from './test/fake-io.ts'

for (const [host, command, fixture] of [
  ['github.com', 'gh pr', 'gh-view-fork-draft'],
  ['gitlab.com', 'glab mr', 'glab-view-fork'],
  ['origin.cursor.com', 'origin pr', 'origin-view.from-docs'],
] as const) {
  test(`${host}: search PRs by exact ID or title`, async () => {
    const pr = JSON.parse(await Bun.file(`${import.meta.dir}/forge/fixtures/${fixture}.json`).text())
    pr.number = pr.iid = 21044
    pr.title = 'Fix login'
    const script = {
      ...cloneScript,
      'git remote get-url origin': { out: `git@${host}:octo/example.git\n` },
      [`${command} view 21044`]: { out: JSON.stringify(pr) },
      [`${command} list`]: { out: JSON.stringify([pr]) },
    }
    for (const query of ['21044', '#21044', ' 21044 ']) {
      const io = fakeIo(script)
      expect(await search(io, 'prs', query)).toMatchObject({ kind: 'prs', hits: [{ number: 21044, title: 'Fix login' }] })
      expect(io.calls.filter((c) => c[0] === command.split(' ')[0]).map((c) => c.slice(1, 4))).toEqual([[command === 'glab mr' ? 'mr' : 'pr', 'view', '21044']])
    }
    for (const query of ['Fix login', 'Fix 21044', undefined]) {
      const io = fakeIo(script)
      expect((await search(io, 'prs', query)).hits).toHaveLength(1)
      const call = io.calls.at(-1)!
      expect(call[2]).toBe('list')
      if (query) expect(call.slice(-2)).toEqual(['--search', query])
      else expect(call).not.toContain('--search')
    }
    for (const [err, kind] of [['PR not found', 'not-found'], ['authentication failed', 'network']]) {
      const io = fakeIo({ ...script, [`${command} view 21044`]: { code: 1, err } })
      if (kind === 'not-found') expect(await search(io, 'prs', '21044')).toEqual({ kind: 'prs', hits: [] })
      else await expect(search(io, 'prs', '21044')).rejects.toMatchObject({ kind })
    }
  })
}
