#!/usr/bin/env node
// Adds this machine's Claude Code usage to a GitHub repository: reads the transcripts under
// ~/.claude/projects into daily per-model token counts and commits them as <device>.json.
//
//   usage-sync.mjs hook <SessionStart|SessionEnd>  what the plugin's hooks run: starts a sync in the
//                                                   background and returns at once
//   usage-sync.mjs sync [--if-due]                 syncs now; --if-due skips it inside the interval
//   usage-sync.mjs status                          where it uploads, and how the last sync went
//
// The plugin's options reach the hooks as CLAUDE_PLUGIN_OPTION_<KEY>. Run by hand, the same values
// can be given as USAGE_SYNC_<KEY> (USAGE_SYNC_REPO, USAGE_SYNC_TOKEN, ...).

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  compact,
  describeError,
  FORMAT_VERSION,
  mergeDays,
  newScan,
  placeSessions,
  reasonOf,
  repoOf,
  sameDays,
  scanLine,
  slugOf,
  toDeviceJson,
  totalsOf,
} from './lib.mjs'

const API = process.env.USAGE_SYNC_API ?? 'https://api.github.com'
const LOCK_STALE_MS = 10 * 60 * 1000
const LOG_KEEP_LINES = 500
const STDIN_WAIT_MS = 300
// A guard against loops, not a limit: a workflow's subagents sit five folders below projects/.
const MAX_DEPTH = 10

const option = (key) => (process.env[`CLAUDE_PLUGIN_OPTION_${key}`] ?? process.env[`USAGE_SYNC_${key}`] ?? '').trim()

const claudeDir = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).replace(/[\\/]+$/, '')
// Outside the plugin's own data folder on purpose: an uninstall keeps the history, and
// /usage-sync:status, which runs without the plugin's environment, can still find it.
const stateDir = join(claudeDir, 'usage-sync')
const paths = {
  state: join(stateDir, 'state.json'),
  scan: join(stateDir, 'scan.json'),
  lock: join(stateDir, 'sync.lock'),
  log: join(stateDir, 'sync.log'),
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

// Every line carries the process id: a hook and the sync it started are two processes, and
// sessions that end together interleave, so the id is what ties a line to its run.
async function log(line) {
  await mkdir(stateDir, { recursive: true })
  await appendFile(paths.log, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
  const lines = (await readFile(paths.log, 'utf8')).split('\n')
  if (lines.length > LOG_KEEP_LINES * 2) await writeFile(paths.log, lines.slice(-LOG_KEEP_LINES).join('\n'))
}

async function settingsOf(state) {
  const timeZone = option('TIME_ZONE') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
  } catch {
    throw new Error(`"${timeZone}" is not a time zone: set an IANA name such as Asia/Kolkata`)
  }
  return {
    repo: repoOf(option('REPO')),
    token: option('TOKEN'),
    branch: option('BRANCH') || 'main',
    folder: option('FOLDER').replace(/^\/+|\/+$/g, ''),
    // Fixed the first time, so renaming the machine keeps its file.
    device: option('DEVICE') ? slugOf(option('DEVICE')) : (state.device ?? slugOf(hostname())),
    label: option('DEVICE_LABEL'),
    timeZone,
    intervalMs: Math.max(5, Number(option('SYNC_INTERVAL_MINUTES')) || 60) * 60_000,
  }
}

async function listTranscripts(folder, depth = 0) {
  if (depth > MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) found.push(...(await listTranscripts(path, depth + 1)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const { size, mtimeMs } = await stat(path)
      found.push({ path, size, mtimeMs })
    }
  }
  return found
}

async function scanFile(scan, path, timeZone, onlyDays) {
  const touched = new Set()
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    const day = scanLine(scan, line, timeZone, onlyDays)
    if (day !== undefined) touched.add(day)
  }
  return touched
}

// Reads only what changed since the last run. Each day a changed transcript touches is counted
// again from every transcript that touches it, so a day is always whole; every other day keeps
// its last count, including days whose transcripts Claude Code has since deleted.
async function scanTranscripts(timeZone) {
  let saved = await readJson(paths.scan, undefined)
  // Counted in another zone or under other counting rules: every day would move, so start over.
  if (saved?.timeZone !== timeZone || saved.version !== FORMAT_VERSION) saved = { version: FORMAT_VERSION, timeZone, files: {}, days: {}, sessions: {} }
  const files = await listTranscripts(join(claudeDir, 'projects'))
  const changed = files.filter((f) => {
    const known = saved.files[f.path]
    return known === undefined || known.size !== f.size || known.mtimeMs !== f.mtimeMs
  })

  const scan = newScan(saved.sessions)
  const recount = new Set()
  const fileDays = {}
  for (const file of changed) {
    const touched = await scanFile(scan, file.path, timeZone)
    fileDays[file.path] = [...touched]
    for (const day of touched) recount.add(day)
  }
  for (const file of files) {
    if (changed.includes(file)) continue
    const known = saved.files[file.path]
    if (known.days.some((day) => recount.has(day))) await scanFile(scan, file.path, timeZone, recount)
  }

  const days = { ...saved.days }
  for (const day of recount) days[day] = scan.days[day]
  placeSessions(days, scan.sessionStarts, timeZone)
  const kept = {}
  for (const file of files) kept[file.path] = { size: file.size, mtimeMs: file.mtimeMs, days: fileDays[file.path] ?? saved.files[file.path].days }
  await writeFile(paths.scan, JSON.stringify({ version: FORMAT_VERSION, timeZone, files: kept, days, sessions: Object.fromEntries(scan.sessionStarts) }))
  return { days, read: changed.length, total: files.length }
}

function github(settings, method, path, body, accept = 'application/vnd.github+json') {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'usage-sync-claude-code-plugin',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const contentsPath = (settings) =>
  `/repos/${settings.repo}/contents/${[...settings.folder.split('/'), `${settings.device}.json`]
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')}`

async function readRemote(settings, path) {
  const ref = `?ref=${encodeURIComponent(settings.branch)}`
  const found = await github(settings, 'GET', path + ref)
  if (found.status === 404) return { sha: undefined, file: undefined }
  if (!found.ok) throw new Error(`GitHub answered ${found.status} reading ${path}: ${reasonOf(await found.text())}`)
  const meta = await found.json()
  // Past 1 MB the contents API leaves `content` out; the raw media type still returns it.
  const text =
    meta.encoding === 'base64' && meta.content
      ? Buffer.from(meta.content, 'base64').toString('utf8')
      : await (await github(settings, 'GET', path + ref, undefined, 'application/vnd.github.raw+json')).text()
  return { sha: meta.sha, file: JSON.parse(text) }
}

async function upload(settings, local) {
  const path = contentsPath(settings)
  let refusal = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const remote = await readRemote(settings, path)
    await log(`upload attempt ${attempt + 1}: remote file ${remote.file === undefined ? 'does not exist yet' : `found (${remote.sha})`}`)
    // A copy counted under other rules cannot be compared day by day: this machine's days replace it.
    const isCurrent = remote.file?.version === FORMAT_VERSION
    const days = mergeDays(remote.file?.days ?? {}, local, { preferLocal: !isCurrent })
    if (remote.file !== undefined && isCurrent && sameDays(days, remote.file.days)) return { days, isChanged: false }

    const file = {
      version: FORMAT_VERSION,
      device: settings.device,
      label: settings.label || remote.file?.label || settings.device,
      timeZone: settings.timeZone,
      updatedAt: new Date().toISOString(),
      days,
    }
    const saved = await github(settings, 'PUT', path, {
      message: `chore: sync claude code usage from ${settings.device}`,
      content: Buffer.from(toDeviceJson(file), 'utf8').toString('base64'),
      branch: settings.branch,
      ...(remote.sha === undefined ? {} : { sha: remote.sha }),
    })
    if (saved.ok) return { days, isChanged: true }
    refusal = `GitHub answered ${saved.status} writing ${path}: ${reasonOf(await saved.text())}`
    await log(`upload attempt ${attempt + 1} refused: ${refusal}`)
    // 409 or 422: another machine's session wrote first, so read it again and merge once more.
    // A second refusal is something else (a missing branch, say) and GitHub's words say what.
    if (saved.status !== 409 && saved.status !== 422) break
  }
  throw new Error(refusal)
}

// One sync at a time per machine: sessions often end together. A lock older than any sync
// takes was left by one that died. Resolves undefined when another sync holds the lock.
async function withLock(work) {
  await mkdir(stateDir, { recursive: true })
  let handle
  try {
    handle = await open(paths.lock, 'wx')
  } catch {
    const held = await stat(paths.lock).catch(() => undefined)
    if (held !== undefined && Date.now() - held.mtimeMs < LOCK_STALE_MS) return undefined
    await rm(paths.lock, { force: true })
    handle = await open(paths.lock, 'wx')
  }
  try {
    return await work()
  } finally {
    await handle.close()
    await rm(paths.lock, { force: true })
  }
}

async function sync(isIfDue) {
  const state = await readJson(paths.state, {})
  const settings = await settingsOf(state)
  await log(
    `sync ${isIfDue ? '--if-due ' : ''}started: repo=${settings.repo ?? '(unset)'} branch=${settings.branch} ` +
      `folder=${settings.folder || '(root)'} device=${settings.device} timeZone=${settings.timeZone} ` +
      `token=${settings.token === '' ? 'missing' : 'set'} intervalMin=${settings.intervalMs / 60_000}`,
  )
  // Only a sync that worked holds this one off: after a failure the next session start tries again.
  if (isIfDue && state.lastSync?.ok) {
    const ageMs = Date.now() - state.lastSync.at
    if (ageMs < settings.intervalMs) {
      await log(`not due: last sync was ${Math.round(ageMs / 60_000)} min ago, interval is ${settings.intervalMs / 60_000} min`)
      return
    }
  } else if (isIfDue && state.lastSync !== undefined) {
    await log('due: the last sync failed, trying again')
  }
  const missing =
    settings.repo === null ? 'the data repository (owner/name)' : settings.token === '' ? 'a GitHub token' : undefined
  if (missing !== undefined) {
    const text = `not set up: set ${missing} in the plugin's options (/plugin, usage-sync)`
    await log(text)
    const lastSync = { at: Date.now(), ok: false, text }
    await mkdir(stateDir, { recursive: true })
    await writeFile(paths.state, JSON.stringify({ device: settings.device, where: 'not set up', lastSync }))
    throw new Error(text)
  }

  const ran = await withLock(async () => {
    const at = Date.now()
    const where = `${settings.repo}@${settings.branch}:${contentsPath(settings).split('/contents/')[1]}`
    try {
      const scanned = await scanTranscripts(settings.timeZone)
      await log(`scanned: read ${scanned.read} of ${scanned.total} transcripts, ${Object.keys(scanned.days).length} days; uploading to ${where}`)
      const { days, isChanged } = await upload(settings, scanned.days)
      const { sessions, tokens } = totalsOf(days)
      const text =
        `${isChanged ? 'Synced' : 'Up to date:'} ${settings.device}.json, ${sessions} sessions and ${compact(tokens)} tokens ` +
        `over ${Object.keys(days).length} days (read ${scanned.read} of ${scanned.total} transcripts)`
      await writeFile(paths.state, JSON.stringify({ device: settings.device, where, lastSync: { at, ok: true, text } }))
      await log(text)
      return true
    } catch (error) {
      const text = describeError(error)
      await writeFile(paths.state, JSON.stringify({ device: settings.device, where, lastSync: { at, ok: false, text } }))
      throw error
    }
  })
  if (ran === undefined) await log('skipped: another sync is running')
}

async function status() {
  const state = await readJson(paths.state, undefined)
  if (state === undefined) {
    console.log(`No sync has run on this machine yet. Its log will be ${paths.log}.`)
    return
  }
  const { at, ok, text } = state.lastSync
  console.log(
    [
      `Device: ${state.device}`,
      `Uploads to: ${state.where}`,
      `Last sync: ${new Date(at).toISOString().replace('T', ' ').slice(0, 16)} UTC, ${ok ? '' : 'failed: '}${text}`,
      `Log: ${paths.log}`,
    ].join('\n'),
  )
}

// What Claude Code writes to a hook's stdin (session id, why it started or ended, ...). Waits for
// a complete JSON document, but never long: a hook must return at once.
function readHookInput() {
  return new Promise((resolve) => {
    let text = ''
    const finish = () => {
      clearTimeout(timer)
      process.stdin.pause()
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(text === '' ? undefined : { unparsed: text.slice(0, 200) })
      }
    }
    const timer = setTimeout(finish, STDIN_WAIT_MS)
    process.stdin.setEncoding('utf8')
    process.stdin.on('error', finish)
    process.stdin.on('end', finish)
    process.stdin.on('data', (chunk) => {
      text += chunk
      try {
        JSON.parse(text)
        finish()
      } catch {
        // not all here yet
      }
    })
  })
}

// A hook returns at once and the sync runs on in its own process group, so neither starting nor
// quitting Claude Code waits on the network, and quitting does not cut the sync short.
async function hook(event) {
  const input = await readHookInput()
  const options = Object.keys(process.env).filter((key) => key.startsWith('CLAUDE_PLUGIN_OPTION_')).map((key) => key.slice('CLAUDE_PLUGIN_OPTION_'.length))
  await log(
    `hook ${event} fired: session=${input?.session_id ?? '?'} ${input?.source ?? input?.reason ?? ''} node=${process.version} ` +
      `pluginRoot=${process.env.CLAUDE_PLUGIN_ROOT ?? '(unset)'} options=[${options.join(',')}]`,
  )
  const args = [fileURLToPath(import.meta.url), 'sync', ...(event === 'SessionStart' ? ['--if-due'] : [])]
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
  child.unref()
  await log(child.pid === undefined ? 'hook could not start the sync process' : `hook started sync process ${child.pid}: ${args.slice(1).join(' ')}`)
  process.exit(0)
}

const [command = 'status', flag] = process.argv.slice(2)
try {
  if (command === 'hook') await hook(flag)
  else if (command === 'sync') await sync(flag === '--if-due')
  else if (command === 'status') await status()
  else {
    console.error('Usage: usage-sync.mjs hook <SessionStart|SessionEnd> | sync [--if-due] | status')
    process.exitCode = 2
  }
} catch (error) {
  const text = describeError(error)
  await log(`failed: ${text}`).catch(() => {})
  console.error(`usage-sync: ${text}`)
  process.exitCode = 1
}
