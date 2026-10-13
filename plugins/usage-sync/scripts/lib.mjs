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

// How the device file counts, so a file written under other rules is replaced rather than merged.
// 2: messages and sessions count as Claude Code's own stats do (see scanLine), tokens once per API
// call, and `hours` is session starts per hour.
export const FORMAT_VERSION = 2

// What one pass over a set of transcripts has counted. `sessionStarts` maps each session to the
// time of its earliest entry; it is handed in from the last pass, because a session is placed on
// the day and hour it started, which a pass over only some transcripts cannot see. `responses`
// holds what each API call has contributed so far, shared by every file of the pass.
export const newScan = (sessionStarts = {}) => ({
  days: {},
  sessionStarts: new Map(Object.entries(sessionStarts)),
  responses: new Map(),
})

// Adds (sign 1) or takes back (sign -1) one API call's tokens from the day it was counted on.
function tally(scan, call, sign) {
  const bucket = (scan.days[call.day] ??= emptyDay())
  const totals = (bucket.models[call.model] ??= emptyModel())
  totals.input += sign * call.input
  totals.output += sign * call.output
  totals.cacheRead += sign * call.cacheRead
  totals.cacheWrite += sign * call.cacheWrite
  totals.requests += sign
}

// Counts as Claude Code's own stats do for messages, which is what the device shows: the main
// conversation's prompts, tool results and responses, one per transcript entry. A subagent's
// entries (isSidechain) are not messages.
//
// Tokens are counted once per API call, which is what the API processed. Claude Code logs a call
// once per content block (thinking, text, each tool use) and a forked or resumed session replays
// earlier entries into a new file, so summing every entry gives about twice the real tokens. The
// entries of one call (message id and request id) share their usage except for output tokens: the
// first ones carry a placeholder and the last the total. The entry with the most output wins.
// A subagent's calls count like any other.
// With `onlyDays`, entries on any other day are left uncounted.
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

  const isResponse = entry.type === 'assistant'
  const usage = entry.message?.usage
  const model = entry.message?.model
  if (isResponse && (!usage || !model || model === '<synthetic>')) return undefined

  // Whatever days are being counted, the session's start is its earliest entry anywhere.
  if (entry.sessionId && ms < (scan.sessionStarts.get(entry.sessionId) ?? Infinity)) scan.sessionStarts.set(entry.sessionId, ms)

  const { day } = localDayAndHour(ms, timeZone)
  if (onlyDays !== undefined && !onlyDays.has(day)) return undefined

  const bucket = (scan.days[day] ??= emptyDay())
  if (!entry.isSidechain) bucket.messages++
  if (isResponse) {
    const call = {
      day,
      model,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    }
    const key = entry.message.id ? `${entry.message.id}:${entry.requestId ?? ''}` : entry.uuid
    const earlier = key === undefined ? undefined : scan.responses.get(key)
    if (earlier !== undefined) {
      if (call.output < earlier.output) return day
      tally(scan, earlier, -1)
    }
    if (key !== undefined) scan.responses.set(key, call)
    tally(scan, call, 1)
  }
  return day
}

// A session counts once, on the day it started, and its start hour is what `hours` tallies. Done
// over every session known, not those the latest pass met, so a day that is recounted keeps the
// sessions that began on it and a session that goes on into a later day is not counted again.
export function placeSessions(days, sessionStarts, timeZone) {
  for (const bucket of Object.values(days)) {
    bucket.sessions = 0
    bucket.hours.fill(0)
  }
  for (const ms of sessionStarts.values()) {
    const { day, hour } = localDayAndHour(ms, timeZone)
    const bucket = (days[day] ??= emptyDay())
    bucket.sessions++
    bucket.hours[hour]++
  }
}

const sorted = (days) => Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)))

// The repository's copy may hold days this machine no longer has (Claude Code prunes transcripts,
// a machine is reinstalled): for each day the fuller of the two wins, so a sync never shrinks it.
// With `preferLocal` (the copy was counted under other rules) this machine's days win outright.
export function mergeDays(remote, local, { preferLocal = false } = {}) {
  const merged = { ...remote }
  for (const [day, bucket] of Object.entries(local)) {
    if (preferLocal || !merged[day] || merged[day].messages <= bucket.messages) merged[day] = bucket
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

// An error's message plus the chain of causes behind it. Node's fetch fails with just "fetch failed";
// what went wrong (ECONNREFUSED, a DNS or certificate error, a timeout) is only in `cause`.
export function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const part = (e) => [e.code, e.message].filter(Boolean).join(' ')
  // A connection that tried several addresses fails with an AggregateError whose own message is empty;
  // the address each attempt failed on is in `errors`.
  const link = (e) => [part(e), ...(e.errors ?? []).map(part)].filter(Boolean).join('; ')
  const causes = []
  for (let cause = error.cause, depth = 0; cause !== undefined && depth < 3; cause = cause?.cause, depth++) {
    causes.push(cause instanceof Error ? link(cause) : String(cause))
  }
  return causes.length === 0 ? error.message : `${error.message} (caused by ${causes.join(' <- ')})`
}
