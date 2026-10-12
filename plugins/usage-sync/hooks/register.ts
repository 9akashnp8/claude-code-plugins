import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  addDays,
  addPrompt,
  addResponse,
  compact,
  fromBase64,
  importLine,
  localDayAndHour,
  mergeDays,
  newImport,
  reasonOf,
  repoOf,
  sameDays,
  slugOf,
  sumSessions,
  systemTimeZone,
  toBase64Ascii,
  toDeviceJson,
  totalsOf,
  type Days,
  type DeviceFile,
  type SessionRecord,
} from './usage'

type Engine = EngineInterface

type Settings = {
  repo: string | null
  token: string
  branch: string
  folder: string
  device: string
  label: string
  timeZone: string
  intervalMs: number
}

type LastSync = { at: number; ok: boolean; text: string }

// Sessions untouched for a day are summed into the index; newer ones are read each time.
type Index = { folded: Record<string, number>; days: Days }

const USAGE = 'Usage: /usage-sync [status | now | import]'
const API = 'https://api.github.com'
const DAY_MS = 24 * 60 * 60 * 1000
// $.fs.read refuses larger files; a transcript past it is skipped by the import.
const MAX_READ = 4 * 1024 * 1024
const FIRST_SYNC_DELAY_MS = 10_000

// The open session's record, read back from its file after a reload.
let current: SessionRecord | null = null
// Responses of parallel subagents land together, and each write replaces the whole file.
let recording: Promise<void> = Promise.resolve()
let syncing: Promise<string> | null = null
let hasWarned = false

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function settingsOf(options: PluginOptions): Settings {
  const text = (key: string) => String(options[key] ?? '').trim()
  return {
    repo: repoOf(text('repo')),
    token: text('token'),
    branch: text('branch') || 'main',
    folder: text('folder').replace(/^\/+|\/+$/g, ''),
    device: text('device') === '' ? '' : slugOf(text('device')),
    label: text('device_label'),
    timeZone: text('time_zone') || systemTimeZone(),
    intervalMs: Math.max(5, Number(options.sync_interval_minutes ?? 60)) * 60_000,
  }
}

async function dirs($: Engine) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const claude = (configured ?? `${home}/.claude`).replace(/[\\/]+$/, '')
  return { claude, data: `${claude}/usage-sync` }
}

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch (error) {
    $.ui.log(`usage-sync: ignoring unreadable ${path}: ${message(error)}`, { to: 'debug' })
    return undefined
  }
}

// The device name is fixed the first time it is needed, so renaming the machine keeps its file.
async function deviceOf($: Engine, settings: Settings) {
  if (settings.device !== '') return settings.device
  const stored = await $.store.get('device')
  if (typeof stored === 'string') return stored
  const { exitCode, stdout } = await $.process.run(['hostname']).catch(() => ({ exitCode: 1, stdout: '' }))
  const device = slugOf(exitCode === 0 ? stdout.trim() : '')
  await $.store.set('device', device)
  return device
}

function record($: Engine, settings: Settings, change: (one: SessionRecord, day: string, hour: number) => SessionRecord) {
  recording = recording
    .then(async () => {
      const id = await $.session.id()
      const { day, hour } = localDayAndHour(await $.clock.now(), settings.timeZone)
      const file = `${(await dirs($)).data}/sessions/${id}.json`
      if (current?.sessionId !== id) {
        current = (await readJson<SessionRecord>($, file)) ?? { sessionId: id, firstDay: day, days: {} }
      }
      current = change(current, day, hour)
      await $.fs.write(file, JSON.stringify(current))
    })
    .catch(error => $.ui.log(`usage-sync: could not record usage: ${message(error)}`, { to: 'debug' }))
  return recording
}

async function localDays($: Engine): Promise<Days> {
  const { data } = await dirs($)
  const folder = `${data}/sessions`
  const entries = (await $.fs.exists(folder)) ? await $.fs.list(folder) : []
  const files = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
  const now = await $.clock.now()
  let index = (await readJson<Index>($, `${data}/index.json`)) ?? { folded: {}, days: {} }

  // A folded session written to again (resumed days later) means the sum is stale: start over.
  const isStale = files.some(file => {
    const folded = index.folded[file.name]
    return folded !== undefined && folded !== file.mtimeMs
  })
  if (isStale) index = { folded: {}, days: {} }

  const toFold: SessionRecord[] = []
  const open: SessionRecord[] = []
  const folded = { ...index.folded }
  for (const file of files) {
    if (index.folded[file.name] !== undefined) continue
    const one = await readJson<SessionRecord>($, `${folder}/${file.name}`)
    if (one === undefined) continue
    if (now - file.mtimeMs > DAY_MS) {
      toFold.push(one)
      folded[file.name] = file.mtimeMs
    } else {
      open.push(one)
    }
  }
  if (toFold.length > 0 || isStale) {
    index = { folded, days: addDays(index.days, sumSessions(toFold)) }
    await $.fs.write(`${data}/index.json`, JSON.stringify(index))
  }

  const imported = (await readJson<{ days: Days }>($, `${data}/imported.json`))?.days ?? {}
  return addDays(addDays(index.days, sumSessions(open)), imported)
}

function github($: Engine, settings: Settings, method: string, path: string, body?: unknown, accept?: string) {
  return $.http.fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'usage-sync-claude-code-plugin',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const contentsPath = (settings: Settings, file: string) =>
  `/repos/${settings.repo}/contents/${[...settings.folder.split('/'), file]
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')}`

async function readRemote($: Engine, settings: Settings, path: string) {
  const ref = `?ref=${encodeURIComponent(settings.branch)}`
  const found = await github($, settings, 'GET', path + ref)
  if (found.status === 404) return { sha: undefined, file: undefined }
  if (!found.ok) throw new Error(`GitHub answered ${found.status} reading ${path}: ${reasonOf(found.text)}`)
  const meta = JSON.parse(found.text) as { sha: string; content?: string; encoding?: string }
  // Past 1 MB the contents API leaves `content` out; the raw media type still returns it.
  const text =
    meta.encoding === 'base64' && meta.content
      ? fromBase64(meta.content)
      : (await github($, settings, 'GET', path + ref, undefined, 'application/vnd.github.raw+json')).text
  return { sha: meta.sha, file: JSON.parse(text) as DeviceFile }
}

async function upload($: Engine, settings: Settings): Promise<string> {
  if (settings.repo === null) return 'Not set up: set the data repository (owner/name) in /config.'
  if (settings.token === '') return 'Not set up: set a GitHub token in /config.'
  const device = await deviceOf($, settings)
  const path = contentsPath(settings, `${device}.json`)
  const local = await localDays($)

  let refusal = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const remote = await readRemote($, settings, path)
    const days = mergeDays(remote.file?.days ?? {}, local)
    if (remote.file !== undefined && sameDays(days, remote.file.days)) return `${device}.json is up to date.`

    const file: DeviceFile = {
      device,
      label: settings.label || remote.file?.label || device,
      timeZone: settings.timeZone,
      updatedAt: new Date(await $.clock.now()).toISOString(),
      days,
    }
    const saved = await github($, settings, 'PUT', path, {
      message: `chore: sync claude code usage from ${device}`,
      content: toBase64Ascii(toDeviceJson(file)),
      branch: settings.branch,
      ...(remote.sha === undefined ? {} : { sha: remote.sha }),
    })
    if (saved.ok) {
      const { sessions, tokens } = totalsOf(days)
      return `Synced ${device}.json: ${sessions} sessions, ${compact(tokens)} tokens.`
    }
    refusal = `GitHub answered ${saved.status} writing ${path}: ${reasonOf(saved.text)}`
    // 409 or 422: another session on this machine wrote it first, so read it again and merge once
    // more. A second refusal is something else (a missing branch, say) and GitHub's words say what.
    if (saved.status !== 409 && saved.status !== 422) break
  }
  throw new Error(refusal)
}

function sync($: Engine, settings: Settings) {
  syncing ??= (async () => {
    const at = await $.clock.now()
    try {
      const text = await upload($, settings)
      await $.store.set('lastSync', { at, ok: true, text } satisfies LastSync)
      return text
    } catch (error) {
      const text = message(error)
      await $.store.set('lastSync', { at, ok: false, text } satisfies LastSync)
      throw error
    }
  })().finally(() => {
    syncing = null
  })
  return syncing
}

// Every open session on the machine shares `lastSync`, so together they sync once per interval.
async function syncIfDue($: Engine, settings: Settings) {
  if (settings.repo === null || settings.token === '') return
  const last = (await $.store.get('lastSync')) as LastSync | undefined
  if (last !== undefined && (await $.clock.now()) - last.at < settings.intervalMs) return
  await sync($, settings).catch(error => {
    $.ui.log(`usage-sync: ${message(error)}`, { to: 'debug' })
    if (!hasWarned) $.ui.toast(`usage-sync could not sync: ${message(error)}`)
    hasWarned = true
  })
}

async function listTranscripts($: Engine, folder: string, depth = 0): Promise<{ path: string; size: number }[]> {
  if (depth > 3 || !(await $.fs.exists(folder))) return []
  const found: { path: string; size: number }[] = []
  for (const entry of await $.fs.list(folder)) {
    const path = `${folder}/${entry.name}`
    if (entry.kind === 'dir') found.push(...(await listTranscripts($, path, depth + 1)))
    else if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) found.push({ path, size: entry.size })
  }
  return found
}

// Days before the plugin started recording, read from the transcripts Claude Code still keeps.
async function importTranscripts($: Engine, settings: Settings) {
  const { claude, data } = await dirs($)
  const liveSince = Number((await $.store.get('liveSince')) ?? (await $.clock.now()))
  const files = await listTranscripts($, `${claude}/projects`)
  const state = newImport()
  const skipped: number[] = []
  for (const file of files) {
    if (file.size >= MAX_READ) {
      skipped.push(file.size)
      continue
    }
    const text = await $.fs.read(file.path).catch(() => '')
    for (const line of text.split('\n')) importLine(state, line, liveSince, settings.timeZone)
  }
  // Transcripts are pruned over time, so a day already imported keeps its fuller count.
  const previous = (await readJson<{ days: Days }>($, `${data}/imported.json`))?.days ?? {}
  const days = mergeDays(previous, state.days)
  await $.fs.write(`${data}/imported.json`, JSON.stringify({ days }))

  const { sessions, tokens } = totalsOf(days)
  const lines = [
    `Imported ${Object.keys(days).length} days from before recording started ` +
      `(${new Date(liveSince).toISOString().replace('T', ' ').slice(0, 16)} UTC): ` +
      `${sessions} sessions, ${compact(tokens)} tokens, from ${files.length - skipped.length} transcripts.`,
  ]
  if (skipped.length > 0) {
    lines.push(
      `Skipped ${skipped.length} transcripts of 4 MB or more (${compact(skipped.reduce((a, b) => a + b, 0))}B in all): ` +
        'plugins cannot read files that large, so those sessions are not in the import.',
    )
  }
  return lines.join('\n')
}

async function status($: Engine, settings: Settings) {
  const { data } = await dirs($)
  const totals = totalsOf(await localDays($))
  const last = (await $.store.get('lastSync')) as LastSync | undefined
  const target =
    settings.repo === null
      ? 'not set (set the data repository in /config)'
      : `${settings.repo}@${settings.branch}:${contentsPath(settings, `${await deviceOf($, settings)}.json`).split('/contents/')[1]}`
  return [
    `Device: ${await deviceOf($, settings)}${settings.label ? ` (${settings.label})` : ''}, time zone ${settings.timeZone}`,
    `Recorded here: ${totals.sessions} sessions, ${totals.messages} messages, ${compact(totals.tokens)} tokens over ${totals.days} days`,
    `Uploads to: ${target}${settings.token === '' ? ', no token set' : ''}`,
    last === undefined
      ? 'Last sync: never'
      : `Last sync: ${new Date(last.at).toISOString().replace('T', ' ').slice(0, 16)} UTC, ${last.ok ? '' : 'failed: '}${last.text}`,
    `Local data: ${data}`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-sync',
      description: 'Sync this device’s Claude Code usage to your GitHub data repository',
      argumentHint: '[status | now | import]',
    })
    if ((await $.store.get('liveSince')) === undefined) await $.store.set('liveSince', await $.clock.now())
    // Off the session's start, so a slow network never holds the first prompt.
    $.clock.after(FIRST_SYNC_DELAY_MS, () => void syncIfDue($, settings))
    $.clock.every(settings.intervalMs, () => void syncIfDue($, settings))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await record($, settings, (one, day) => addPrompt(one, day))
    return next(e)
  })

  // Each model request, the main loop's and every subagent's, with the usage the API reported.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      await record($, settings, (one, day, hour) => addResponse(one, day, hour, usage, result.toolUses.length))
    }
    return result
  })

  on('command.run', { command: 'usage-sync' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    try {
      switch (verb) {
        case '':
        case 'status':
          return { text: await status($, settings) }
        case 'now':
          return { text: await sync($, settings) }
        case 'import': {
          const imported = await importTranscripts($, settings)
          const synced = settings.repo === null ? '' : `\n${await sync($, settings)}`
          return { text: imported + synced }
        }
        default:
          return { text: USAGE }
      }
    } catch (error) {
      return { text: `usage-sync: ${message(error)}` }
    }
  })
}
