// node --test plugins/usage-sync/tests/*.test.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describeError, localDayAndHour, mergeDays, newScan, repoOf, scanLine, toDeviceJson } from '../scripts/lib.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/usage-sync.mjs', import.meta.url))
const run = promisify(execFile)

const prompt = (ts, uuid, sessionId = 's1') => JSON.stringify({ type: 'user', timestamp: ts, sessionId, uuid })
const response = (ts, id, { model = 'claude-opus-5-5', sessionId = 's1', output = 100 } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId,
    requestId: `req-${id}`,
    message: {
      id: `msg-${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    },
  })

test('a response logged once per content block counts once', () => {
  const scan = newScan()
  for (const line of [prompt('2026-10-11T08:00:00Z', 'u1'), response('2026-10-11T08:00:01Z', 1), response('2026-10-11T08:00:01Z', 1)]) {
    scanLine(scan, line, 'UTC')
  }
  const day = scan.days['2026-10-11']
  assert.equal(day.sessions, 1)
  assert.equal(day.messages, 2)
  assert.equal(day.hours[8], 1)
  assert.deepEqual(day.models['claude-opus-5-5'], { input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, requests: 1 })
})

test('meta entries, other events and broken lines are not counted', () => {
  const scan = newScan()
  scanLine(scan, JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-10-11T08:00:00Z', uuid: 'm' }), 'UTC')
  scanLine(scan, JSON.stringify({ type: 'attachment', timestamp: '2026-10-11T08:00:00Z' }), 'UTC')
  scanLine(scan, '{"type":"user","timestamp":', 'UTC')
  assert.deepEqual(scan.days, {})
})

test('with onlyDays, entries on other days are neither counted nor marked seen', () => {
  const scan = newScan()
  assert.equal(scanLine(scan, response('2026-10-10T08:00:00Z', 1), 'UTC', new Set(['2026-10-11'])), undefined)
  assert.equal(scan.seenResponses.size, 0)
  assert.equal(scanLine(scan, response('2026-10-11T08:00:00Z', 2), 'UTC', new Set(['2026-10-11'])), '2026-10-11')
})

test('days and hours follow the time zone', () => {
  assert.deepEqual(localDayAndHour(Date.UTC(2026, 9, 11, 20), 'Asia/Kolkata'), { day: '2026-10-12', hour: 1 })
  assert.deepEqual(localDayAndHour(Date.UTC(2026, 9, 11, 20), 'UTC'), { day: '2026-10-11', hour: 20 })
})

test('merging keeps the fuller copy of each day', () => {
  const day = (messages) => ({ sessions: 1, messages, hours: new Array(24).fill(0), models: {} })
  const merged = mergeDays({ a: day(5), b: day(9) }, { b: day(3), c: day(1) })
  assert.deepEqual(Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.messages])), { a: 5, b: 9, c: 1 })
})

test('the device file puts each hour array on one line', () => {
  const json = toDeviceJson({ days: { d: { sessions: 1, messages: 1, hours: new Array(24).fill(0), models: {} } } })
  assert.match(json, /"hours": \[0, 0, 0/)
})

test('the repository can be given as a URL', () => {
  assert.equal(repoOf('https://github.com/me/usage-data.git'), 'me/usage-data')
  assert.equal(repoOf('me/usage-data'), 'me/usage-data')
  assert.equal(repoOf('not a repo'), null)
})

// End to end: the script against a fake GitHub and a temporary ~/.claude.
let server
let api
let remote
let requests
let home

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET') {
        if (remote === undefined) return res.writeHead(404).end('{"message":"Not Found"}')
        return res.end(JSON.stringify({ sha: remote.sha, encoding: 'base64', content: Buffer.from(remote.text).toString('base64') }))
      }
      const parsed = JSON.parse(body)
      remote = { sha: `sha-${requests.length}`, text: Buffer.from(parsed.content, 'base64').toString('utf8') }
      res.writeHead(201).end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

async function freshMachine() {
  remote = undefined
  requests = []
  home = await mkdtemp(join(tmpdir(), 'usage-sync-'))
  await mkdir(join(home, 'projects', 'proj', 's1', 'subagents'), { recursive: true })
}

const env = (extra = {}) => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: home,
  USAGE_SYNC_API: api,
  CLAUDE_PLUGIN_OPTION_REPO: 'me/usage-data',
  CLAUDE_PLUGIN_OPTION_TOKEN: 'secret',
  CLAUDE_PLUGIN_OPTION_DEVICE: 'laptop',
  CLAUDE_PLUGIN_OPTION_DEVICE_LABEL: 'Work laptop',
  CLAUDE_PLUGIN_OPTION_FOLDER: 'devices',
  CLAUDE_PLUGIN_OPTION_TIME_ZONE: 'UTC',
  ...extra,
})

const uploaded = () => JSON.parse(remote.text)
const puts = () => requests.filter((r) => r.method === 'PUT')

test('a sync uploads the device file, and the next finds it up to date', async () => {
  await freshMachine()
  const main = join(home, 'projects', 'proj', 's1.jsonl')
  await writeFile(main, [prompt('2026-10-11T08:00:00Z', 'u1'), response('2026-10-11T08:00:01Z', 1)].join('\n') + '\n')
  // A subagent's transcript: same session, its own responses.
  await writeFile(join(home, 'projects', 'proj', 's1', 'subagents', 'a.jsonl'), response('2026-10-11T08:00:02Z', 2, { model: 'claude-haiku-5-5' }) + '\n')

  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.equal(puts().length, 1)
  assert.equal(puts()[0].url, '/repos/me/usage-data/contents/devices/laptop.json')
  assert.equal(puts()[0].body.branch, 'main')
  assert.equal(requests[0].auth, 'Bearer secret')
  const day = uploaded().days['2026-10-11']
  assert.equal(uploaded().label, 'Work laptop')
  assert.equal(day.sessions, 1)
  assert.equal(day.messages, 3)
  assert.deepEqual(Object.keys(day.models).sort(), ['claude-haiku-5-5', 'claude-opus-5-5'])

  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.equal(puts().length, 1)
  const log = await readFile(join(home, 'usage-sync', 'sync.log'), 'utf8')
  assert.doesNotMatch(log, /skipped/)
  const { stdout } = await run(process.execPath, [SCRIPT, 'status'], { env: env() })
  assert.match(stdout, /Up to date: laptop\.json, 1 sessions and 2\.3k tokens over 1 days \(read 0 of 2 transcripts\)/)
})

test('only changed transcripts are read, a day they touch is recounted whole, and pruned days stay', async () => {
  await freshMachine()
  const old = join(home, 'projects', 'proj', 'old.jsonl')
  const today = join(home, 'projects', 'proj', 's1.jsonl')
  await writeFile(old, response('2026-09-01T10:00:00Z', 9, { sessionId: 's0' }) + '\n' + response('2026-10-11T07:00:00Z', 8, { sessionId: 's0' }) + '\n')
  await writeFile(today, response('2026-10-11T08:00:00Z', 1) + '\n')
  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.equal(uploaded().days['2026-10-11'].messages, 2)

  // The session goes on: only s1 changed, but 10-11 still counts old.jsonl's response.
  await appendFile(today, response('2026-10-11T09:00:00Z', 2) + '\n')
  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.equal(uploaded().days['2026-10-11'].messages, 3)
  assert.equal(uploaded().days['2026-10-11'].sessions, 2)
  const scan = JSON.parse(await readFile(join(home, 'usage-sync', 'scan.json'), 'utf8'))
  assert.deepEqual(scan.files[old].days.sort(), ['2026-09-01', '2026-10-11'])

  // Claude Code deletes the old transcript: its September day is kept.
  await rm(old)
  await appendFile(today, response('2026-10-12T09:00:00Z', 3) + '\n')
  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.deepEqual(Object.keys(uploaded().days), ['2026-09-01', '2026-10-11', '2026-10-12'])
  assert.equal(uploaded().days['2026-10-11'].messages, 3)
})

test('days only the repository still has are kept', async () => {
  await freshMachine()
  const old = { sessions: 3, messages: 90, hours: new Array(24).fill(0), models: {} }
  remote = { sha: 'sha-0', text: toDeviceJson({ device: 'laptop', label: 'Laptop', days: { '2026-01-01': old } }) }
  await writeFile(join(home, 'projects', 'proj', 's1.jsonl'), response('2026-10-11T08:00:00Z', 1) + '\n')
  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.equal(puts()[0].body.sha, 'sha-0')
  assert.deepEqual(Object.keys(uploaded().days), ['2026-01-01', '2026-10-11'])
})

test('without a repository the sync fails and status says what to set', async () => {
  await freshMachine()
  await assert.rejects(run(process.execPath, [SCRIPT, 'sync'], { env: env({ CLAUDE_PLUGIN_OPTION_REPO: '' }) }))
  const { stdout } = await run(process.execPath, [SCRIPT, 'status'], { env: env() })
  assert.match(stdout, /failed: not set up: set the data repository/)
  assert.equal(requests.length, 0)
})

test('the SessionEnd hook returns at once and the sync finishes in the background', async () => {
  await freshMachine()
  await writeFile(join(home, 'projects', 'proj', 's1.jsonl'), response('2026-10-11T08:00:00Z', 1) + '\n')
  const started = Date.now()
  await run(process.execPath, [SCRIPT, 'hook', 'SessionEnd'], { env: env() })
  assert.ok(Date.now() - started < 2000)
  for (let i = 0; i < 50 && puts().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(puts().length, 1)
})

test('a sync that finds the lock held skips', async () => {
  await freshMachine()
  await mkdir(join(home, 'usage-sync'), { recursive: true })
  await writeFile(join(home, 'usage-sync', 'sync.lock'), '')
  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  assert.equal(requests.length, 0)
  assert.match(await readFile(join(home, 'usage-sync', 'sync.log'), 'utf8'), /skipped: another sync is running/)
})

test('the SessionStart hook skips a sync inside the interval', async () => {
  await freshMachine()
  await writeFile(join(home, 'projects', 'proj', 's1.jsonl'), response('2026-10-11T08:00:00Z', 1) + '\n')
  await run(process.execPath, [SCRIPT, 'sync'], { env: env() })
  const before = requests.length
  await run(process.execPath, [SCRIPT, 'sync', '--if-due'], { env: env() })
  assert.equal(requests.length, before)
})

test('an error is described with the causes behind it', () => {
  assert.equal(describeError(new Error('plain')), 'plain')
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
  assert.equal(describeError(new Error('fetch failed', { cause })), 'fetch failed (caused by ECONNREFUSED connect ECONNREFUSED 127.0.0.1:9)')
  const several = Object.assign(new AggregateError([cause, cause]), { code: 'ECONNREFUSED' })
  assert.match(describeError(new Error('fetch failed', { cause: several })), /caused by ECONNREFUSED; ECONNREFUSED connect ECONNREFUSED 127.0.0.1:9; ECONNREFUSED connect/)
})

// A port nothing listens on: the connection is refused at once.
async function deadApi() {
  const probe = createSocketServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return `http://127.0.0.1:${port}`
}

test('a failed sync logs why, and the next SessionStart sync tries again', async () => {
  await freshMachine()
  await writeFile(join(home, 'projects', 'proj', 's1.jsonl'), response('2026-10-11T08:00:00Z', 1) + '\n')
  await assert.rejects(run(process.execPath, [SCRIPT, 'sync'], { env: env({ USAGE_SYNC_API: await deadApi() }) }))
  assert.match(await readFile(join(home, 'usage-sync', 'sync.log'), 'utf8'), /failed: fetch failed \(caused by .*ECONNREFUSED/)
  const { stdout } = await run(process.execPath, [SCRIPT, 'status'], { env: env() })
  assert.match(stdout, /failed: fetch failed \(caused by .*ECONNREFUSED/)

  await run(process.execPath, [SCRIPT, 'sync', '--if-due'], { env: env() })
  assert.equal(puts().length, 1)
  assert.match(await readFile(join(home, 'usage-sync', 'sync.log'), 'utf8'), /due: the last sync failed, trying again/)
})
