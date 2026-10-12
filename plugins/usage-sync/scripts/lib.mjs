// Pure helpers for usage-sync.mjs: reading transcript lines into daily buckets, merging days,
// and the device file's text. No file system or network here, so the tests can run them alone.

export const emptyDay = () => ({ sessions: 0, messages: 0, hours: new Array(24).fill(0), models: {} })

const emptyModel = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 })

export const slugOf = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'device'

// `owner/name`, as typed or pasted as a URL; null when it is neither.
export function repoOf(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

// One formatter per zone: building it is the slow part of reading a large transcript.
const formatters = new Map()

export function localDayAndHour(ms, timeZone) {
  let format = formatters.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 }
}

// What one pass over a set of transcripts has counted. The seen sets are shared by every file of
// the pass, so a response or prompt that appears in two files counts once.
export const newScan = () => ({
  days: {},
  seenSessions: new Set(),
  seenResponses: new Set(),
  seenPrompts: new Set(),
})

// Counts as the transcript does: each prompt or tool result is a message, and each model response
// is one message carrying its usage. A response is logged once per content block with the same
// usage, so it counts once by message id; a resumed session replays user entries, counted by uuid.
// With `onlyDays`, entries on any other day are left alone, uncounted and unmarked.
// Returns the day the line counted on, if it did.
export function scanLine(scan, line, timeZone, onlyDays) {
  if (!line.includes('"timestamp"')) return undefined
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!entry.timestamp || (entry.type !== 'user' && entry.type !== 'assistant')) return undefined
  const ms = Date.parse(entry.timestamp)
  if (Number.isNaN(ms)) return undefined
  const { day, hour } = localDayAndHour(ms, timeZone)
  if (onlyDays !== undefined && !onlyDays.has(day)) return undefined

  if (entry.type === 'user') {
    if (entry.isMeta || (entry.uuid && scan.seenPrompts.has(entry.uuid))) return undefined
    if (entry.uuid) scan.seenPrompts.add(entry.uuid)
    bucketOf(scan, day, entry.sessionId).messages++
    return day
  }

  const usage = entry.message?.usage
  const model = entry.message?.model
  if (!usage || !model || model === '<synthetic>') return undefined
  const key = entry.message.id ? `${entry.message.id}:${entry.requestId ?? ''}` : entry.uuid
  if (key === undefined || scan.seenResponses.has(key)) return undefined
  scan.seenResponses.add(key)
  const bucket = bucketOf(scan, day, entry.sessionId)
  bucket.messages++
  bucket.hours[hour]++
  const totals = (bucket.models[model] ??= emptyModel())
  totals.input += usage.input_tokens ?? 0
  totals.output += usage.output_tokens ?? 0
  totals.cacheRead += usage.cache_read_input_tokens ?? 0
  totals.cacheWrite += usage.cache_creation_input_tokens ?? 0
  totals.requests++
  return day
}

// A session counts once, on the first day it is seen.
function bucketOf(scan, day, sessionId) {
  const bucket = (scan.days[day] ??= emptyDay())
  if (sessionId && !scan.seenSessions.has(sessionId)) {
    scan.seenSessions.add(sessionId)
    bucket.sessions++
  }
  return bucket
}

const sorted = (days) => Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)))

// The repository's copy may hold days this machine no longer has (Claude Code prunes transcripts,
// a machine is reinstalled): for each day the fuller of the two wins, so a sync never shrinks it.
export function mergeDays(remote, local) {
  const merged = { ...remote }
  for (const [day, bucket] of Object.entries(local)) {
    if (!merged[day] || merged[day].messages <= bucket.messages) merged[day] = bucket
  }
  return sorted(merged)
}

export const sameDays = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

// Hour arrays on one line keep the data repository's diffs readable.
export const toDeviceJson = (file) =>
  JSON.stringify(file, null, 2).replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`) + '\n'

export function totalsOf(days) {
  let sessions = 0
  let messages = 0
  let tokens = 0
  for (const bucket of Object.values(days)) {
    sessions += bucket.sessions
    messages += bucket.messages
    for (const m of Object.values(bucket.models)) tokens += m.input + m.output + m.cacheRead + m.cacheWrite
  }
  return { sessions, messages, tokens, days: Object.keys(days).length }
}

export function compact(n) {
  for (const [size, suffix] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]) {
    if (n >= size) return `${(n / size).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return String(n)
}

export function reasonOf(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed.message) return parsed.message
  } catch {
    // not JSON
  }
  return String(text).trim().split('\n')[0]?.slice(0, 200) ?? ''
}
