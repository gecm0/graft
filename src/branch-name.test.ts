import { describe, expect, test } from 'bun:test'
import { render, slug, templateUser, titleBranch, today } from './branch-name.ts'
import { fakeIo } from './test/fake-io.ts'

describe('render', () => {
  test('fills variables', () => {
    expect(render('{key}-{slug}', { slug: 'fix-login' })).toBe('fix-login')
    expect(render('{user}/{key}-{slug}', { user: 'alice', slug: 'fix-login' })).toBe('alice/fix-login')
    expect(render('{user}/{key}-{slug}', { user: 'alice', key: 'abc-123', slug: 'title' })).toBe('alice/abc-123-title')
    expect(render('{date}_{slug}', { date: '2026-11-01', slug: 'x' })).toBe('2026-11-01_x')
    expect(render('{linear}', { linear: 'alice/abc-123-title' })).toBe('alice/abc-123-title')
  })

  test('empty variables drop with their dangling separators', () => {
    expect(render('{user}/{key}-{slug}', { slug: 'fix-login' })).toBe('fix-login')
    expect(render('feat/{key}-{slug}-{date}', { slug: 'a' })).toBe('feat/a')
    expect(render('{user}/{key}', {})).toBe('')
  })

  test('an unknown variable is a usage error', () => {
    expect(() => render('{who}-{slug}', { slug: 'a' })).toThrow(expect.objectContaining({ kind: 'usage' }))
  })
})

test('slug', () => {
  expect(slug('Fix the Login page!')).toBe('fix-the-login-page')
  expect(slug('  Café  über  ')).toBe('cafe-uber')
  expect(slug('!!!')).toBe('')
  expect(slug('a'.repeat(47) + ' bcd')).toBe('a'.repeat(47))
})

test('today is local YYYY-MM-DD', () => {
  expect(today(new Date(2026, 0, 5))).toBe('2026-01-05')
})

describe('templateUser', () => {
  test('user config, then github.user, then the email before "@"', async () => {
    expect(await templateUser(fakeIo(), '/r', 'alice')).toBe('alice')
    const gh = fakeIo({ 'git config --get github.user': { out: 'octo\n' }, 'git config --get user.email': { out: 'bob@x.test\n' } })
    expect(await templateUser(gh, '/r')).toBe('octo')
    expect(await templateUser(fakeIo({ 'git config --get user.email': { out: 'bob@x.test\n' } }), '/r')).toBe('bob')
    expect(await templateUser(fakeIo(), '/r')).toBe('')
  })
})

describe('titleBranch', () => {
  test('default template is {key}-{slug}; {user} only asks git when used', async () => {
    const io = fakeIo()
    expect(await titleBranch(io, '/r', 'Fix login')).toBe('fix-login')
    expect(io.calls).toEqual([])
    expect(await titleBranch(io, '/r', 'Fix login', '{user}/{key}-{slug}', 'alice')).toBe('alice/fix-login')
  })

  test('a title or template that yields no name is a usage error', async () => {
    await expect(titleBranch(fakeIo(), '/r', '???')).rejects.toMatchObject({ kind: 'usage' })
    await expect(titleBranch(fakeIo(), '/r', 'Fix', '{key}')).rejects.toMatchObject({ kind: 'usage' })
  })
})
