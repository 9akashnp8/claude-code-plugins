import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import {
  addResponse,
  fromBase64,
  importLine,
  localDayAndHour,
  mergeDays,
  newImport,
  repoOf,
  sumSessions,
  toBase64Ascii,
  toDeviceJson,
  type DeviceFile,
  type SessionRecord,
} from '../hooks/usage'

const OPTIONS = {
  repo: 'me/usage-data',
  token: 'secret',
  branch: 'main',
  folder: 'devices',
  device: 'laptop',
  device_label: 'Work laptop',
  time_zone: 'UTC',
  sync_interval_minutes: 60,
}

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 200,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 300,
}

// 2026-10-12 09:30 UTC
const NOW = Date.UTC(2026, 9, 12, 9, 30)

// A file system in memory, the store, the clock, the session id, and GitHub's contents API,
// answering beneath the plugin.
function fakeMachine(on: On, remote?: DeviceFile, toolUses = 0) {
  const files = new Map<string, string>()
  const written = new Map<string, number>()
  const puts: { path: string; body: { content: string; sha?: string; branch: string } }[] = []
  let stored = remote === undefined ? undefined : { sha: 'sha-1', text: toDeviceJson(remote) }

  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: Array.from({ length: toolUses }, (_, i) => ({ id: `tool-${i}`, name: 'Bash', input: {} })),
      stopReason: 'end_turn' as const,
      usage: USAGE,
    }
  })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({
    value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)),
  }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    written.set(e.path, clock.now())
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = new Set<string>()
    for (const path of files.keys()) {
      if (path.startsWith(`${e.path}/`)) names.add(path.slice(e.path.length + 1).split('/')[0] ?? '')
    }
    return {
      value: [...names].map(name => {
        const text = files.get(`${e.path}/${name}`)
        return text === undefined
          ? { name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
          : { name, kind: 'file' as const, size: text.length, mtimeMs: written.get(`${e.path}/${name}`) ?? 0, isLink: false }
      }),
    }
  })
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('https://api.github.com', '').split('?')[0] ?? ''
    if (method === 'GET') {
      if (stored === undefined) return { value: { status: 404, ok: false, headers: {}, text: '{"message":"Not Found"}' } }
      const body = { sha: stored.sha, encoding: 'base64', content: toBase64Ascii(stored.text) }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    }
    const body = JSON.parse(e.init?.body ?? '{}')
    puts.push({ path, body })
    stored = { sha: `sha-${puts.length + 1}`, text: fromBase64(body.content) }
    return { value: { status: 201, ok: true, headers: {}, text: '{}' } }
  })

  const uploaded = () => (stored === undefined ? undefined : (JSON.parse(stored.text) as DeviceFile))
  return { files, puts, clock, uploaded }
}

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'usage-sync',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

async function respond($: Engine) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: USAGE.model, messageCount: 1 })
  for await (const _ of stream);
  return stream.result
}

test('a response and its tool results are recorded against the session and the hour', async ($, on) => {
  const { files } = fakeMachine(on, undefined, 2)
  await $.session.start({ cwd: '/code', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix the bug', turnId: 't' })
  await respond($)

  const saved = JSON.parse(files.get('/home/me/.claude/usage-sync/sessions/session-1.json') ?? '{}') as SessionRecord
  const day = saved.days['2026-10-12']
  expect(saved.firstDay).toBe('2026-10-12')
  expect(day?.messages).toBe(4)
  expect(day?.hours[9]).toBe(1)
  expect(day?.models['claude-opus-5-5']).toEqual({ input: 10, output: 200, cacheRead: 5000, cacheWrite: 300, requests: 1 })
})

test('/usage-sync now uploads the device file, then finds it up to date', { options: OPTIONS }, async ($, on) => {
  const { puts, uploaded } = fakeMachine(on)
  await $.session.start({ cwd: '/code', surface: 'terminal', isInteractive: true })
  await respond($)

  const first = await run($, 'now')
  expect(first.text).toBe('Synced laptop.json: 1 sessions, 5.5k tokens.')
  expect(puts[0]?.path).toBe('/repos/me/usage-data/contents/devices/laptop.json')
  expect(puts[0]?.body.branch).toBe('main')
  expect(uploaded()?.label).toBe('Work laptop')
  expect(uploaded()?.days['2026-10-12']?.sessions).toBe(1)

  const second = await run($, 'now')
  expect(second.text).toBe('laptop.json is up to date.')
  expect(puts.length).toBe(1)
})

test('a sync keeps the days only the remote copy still has', { options: OPTIONS }, async ($, on) => {
  const old = { sessions: 3, messages: 90, hours: new Array(24).fill(0), models: {} }
  const remote: DeviceFile = { device: 'laptop', label: 'Laptop', timeZone: 'UTC', updatedAt: '', days: { '2026-01-01': old } }
  const { puts, uploaded } = fakeMachine(on, remote)
  await $.session.start({ cwd: '/code', surface: 'terminal', isInteractive: true })
  await respond($)

  await run($, 'now')
  expect(puts[0]?.body.sha).toBe('sha-1')
  expect(Object.keys(uploaded()?.days ?? {})).toEqual(['2026-01-01', '2026-10-12'])
})

test('an open session syncs on its own, and a day-old session is folded into the index', { options: OPTIONS }, async ($, on) => {
  const { files, clock, puts, uploaded } = fakeMachine(on)
  await $.session.start({ cwd: '/code', surface: 'terminal', isInteractive: true })
  await respond($)
  await clock.advance(2 * 24 * 60 * 60 * 1000)

  // The first sync after start uploaded it; the hourly ones since found nothing new.
  expect(puts.length).toBe(1)
  const index = JSON.parse(files.get('/home/me/.claude/usage-sync/index.json') ?? '{}')
  expect(Object.keys(index.folded)).toEqual(['session-1.json'])
  expect((await run($, 'now')).text).toBe('laptop.json is up to date.')
  expect(uploaded()?.days['2026-10-12']?.models['claude-opus-5-5']?.requests).toBe(1)
})

test('without a repository the command says what to set', async ($, on) => {
  fakeMachine(on)
  const { text } = await run($, 'now')
  expect(text).toBe('Not set up: set the data repository (owner/name) in /config.')
})

test('a session counts once, on its first day', () => {
  const one: SessionRecord = { sessionId: 'a', firstDay: '2026-10-11', days: {} }
  const spanning = addResponse(addResponse(one, '2026-10-11', 23, USAGE), '2026-10-12', 0, USAGE)
  const days = sumSessions([spanning, { ...spanning, sessionId: 'b', firstDay: '2026-10-12' }])
  expect(days['2026-10-11']?.sessions).toBe(1)
  expect(days['2026-10-12']?.sessions).toBe(1)
  expect(days['2026-10-12']?.messages).toBe(2)
})

test('merging keeps the fuller copy of each day', () => {
  const day = (messages: number) => ({ sessions: 1, messages, hours: new Array(24).fill(0), models: {} })
  const merged = mergeDays({ a: day(5), b: day(9) }, { b: day(3), c: day(1) })
  expect(merged.a?.messages).toBe(5)
  expect(merged.b?.messages).toBe(9)
  expect(merged.c?.messages).toBe(1)
})

test('the import counts a response once however many blocks repeat it, and stops at a time', () => {
  const state = newImport()
  const response = (ts: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      sessionId: 's',
      requestId: 'r1',
      message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2 } },
    })
  const before = Date.UTC(2026, 9, 12)
  importLine(state, JSON.stringify({ type: 'user', timestamp: '2026-10-11T08:00:00Z', sessionId: 's', uuid: 'u1' }), before, 'UTC')
  importLine(state, response('2026-10-11T08:00:01Z'), before, 'UTC')
  importLine(state, response('2026-10-11T08:00:01Z'), before, 'UTC')
  importLine(state, JSON.stringify({ type: 'user', timestamp: '2026-10-12T08:00:00Z', sessionId: 's', uuid: 'u2' }), before, 'UTC')
  importLine(state, '{"type":"user","timestamp":', before, 'UTC')

  expect(Object.keys(state.days)).toEqual(['2026-10-11'])
  expect(state.days['2026-10-11']?.sessions).toBe(1)
  expect(state.days['2026-10-11']?.messages).toBe(2)
  expect(state.days['2026-10-11']?.models['claude-sonnet-5']?.requests).toBe(1)
})

test('days and hours follow the configured time zone', () => {
  // 20:00 UTC is 01:30 the next day in India.
  expect(localDayAndHour(Date.UTC(2026, 9, 11, 20), 'Asia/Kolkata')).toEqual({ day: '2026-10-12', hour: 1 })
  expect(localDayAndHour(Date.UTC(2026, 9, 11, 20), 'UTC')).toEqual({ day: '2026-10-11', hour: 20 })
})

test('the device file is ASCII with each hour array on one line', () => {
  const day = { sessions: 1, messages: 2, hours: new Array(24).fill(0), models: {} }
  const json = toDeviceJson({ device: 'laptop', label: 'Café', timeZone: 'UTC', updatedAt: '', days: { d: day } })
  expect(json).toContain('"hours": [0, 0, 0')
  expect(json).toContain('Caf\\u00e9')
  expect((JSON.parse(fromBase64(toBase64Ascii(json))) as DeviceFile).label).toBe('Café')
})

test('the repository can be given as a URL', () => {
  expect(repoOf('https://github.com/me/usage-data.git')).toBe('me/usage-data')
  expect(repoOf('me/usage-data')).toBe('me/usage-data')
  expect(repoOf('not a repo')).toBe(null)
})
