// Pure helpers: buckets, merging, the device file and transcript lines. No `$` here.

export type ModelTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }

// One calendar day in the configured time zone; `hours` counts responses per hour.
export type DayBucket = {
  sessions: number
  messages: number
  hours: number[]
  models: Record<string, ModelTotals>
}

export type Days = Record<string, DayBucket>

// What one session recorded on this device, kept in its own file so concurrent sessions never share a write.
export type SessionRecord = { sessionId: string; firstDay: string; days: Days }

// The file each device owns in the data repository; the site merges every device's.
export type DeviceFile = { device: string; label: string; timeZone: string; updatedAt: string; days: Days }

export type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export const emptyDay = (): DayBucket => ({ sessions: 0, messages: 0, hours: new Array(24).fill(0), models: {} })

export const emptyModel = (): ModelTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 })

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'device'

const pad = (n: number) => String(n).padStart(2, '0')

// Intl may be missing in a hooks environment; then days fall back to UTC.
export function localDayAndHour(ms: number, timeZone: string): { day: string; hour: number } {
  if (typeof Intl !== 'undefined' && timeZone !== 'UTC') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(ms))
      const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
      return { day: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) % 24 }
    } catch {
      // An unknown zone name: fall through to UTC rather than drop the response.
    }
  }
  const date = new Date(ms)
  return {
    day: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    hour: date.getUTCHours(),
  }
}

export function systemTimeZone() {
  try {
    return typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// A response is one message, and each tool it calls comes back as one more (the tool result), as
// the transcript counts them.
export function addResponse(
  record: SessionRecord,
  day: string,
  hour: number,
  usage: Usage,
  toolResults = 0,
): SessionRecord {
  const bucket = record.days[day] ?? emptyDay()
  const model = bucket.models[usage.model] ?? emptyModel()
  const hours = bucket.hours.slice()
  hours[hour] = (hours[hour] ?? 0) + 1
  return {
    ...record,
    days: {
      ...record.days,
      [day]: {
        ...bucket,
        messages: bucket.messages + 1 + toolResults,
        hours,
        models: {
          ...bucket.models,
          [usage.model]: {
            input: model.input + usage.input_tokens,
            output: model.output + usage.output_tokens,
            cacheRead: model.cacheRead + usage.cache_read_input_tokens,
            cacheWrite: model.cacheWrite + usage.cache_creation_input_tokens,
            requests: model.requests + 1,
          },
        },
      },
    },
  }
}

export function addPrompt(record: SessionRecord, day: string): SessionRecord {
  const bucket = record.days[day] ?? emptyDay()
  return { ...record, days: { ...record.days, [day]: { ...bucket, messages: bucket.messages + 1 } } }
}

function addBuckets(a: DayBucket, b: DayBucket): DayBucket {
  const models = { ...a.models }
  for (const [id, m] of Object.entries(b.models)) {
    const into = models[id] ?? emptyModel()
    models[id] = {
      input: into.input + m.input,
      output: into.output + m.output,
      cacheRead: into.cacheRead + m.cacheRead,
      cacheWrite: into.cacheWrite + m.cacheWrite,
      requests: into.requests + m.requests,
    }
  }
  return {
    sessions: a.sessions + b.sessions,
    messages: a.messages + b.messages,
    hours: a.hours.map((count, hour) => count + (b.hours[hour] ?? 0)),
    models,
  }
}

// A session counts once, on the first day it was active.
export function sumSessions(records: readonly SessionRecord[]): Days {
  const days: Days = {}
  for (const record of records) {
    for (const [day, bucket] of Object.entries(record.days)) {
      const counted = { ...bucket, sessions: day === record.firstDay ? 1 : 0 }
      days[day] = addBuckets(days[day] ?? emptyDay(), counted)
    }
  }
  return days
}

// Days from different sources never overlap, so they add.
export function addDays(a: Days, b: Days): Days {
  const days: Days = { ...a }
  for (const [day, bucket] of Object.entries(b)) days[day] = days[day] ? addBuckets(days[day], bucket) : bucket
  return days
}

// The remote copy may hold days this machine no longer has (a reinstall, pruned transcripts):
// for each day the fuller of the two wins, so a sync never shrinks the record.
export function mergeDays(remote: Days, local: Days): Days {
  const merged: Days = { ...remote }
  for (const [day, bucket] of Object.entries(local)) {
    const other = merged[day]
    if (!other || other.messages <= bucket.messages) merged[day] = bucket
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))
}

export const sameDays = (a: Days, b: Days) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

const sorted = (days: Days) => Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)))

// Hour arrays on one line keep the data repository's diffs readable; non-ASCII is escaped so the
// text is plain ASCII and base64 needs no UTF-8 step.
export function toDeviceJson(file: DeviceFile) {
  return (
    JSON.stringify(file, null, 2)
      .replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s*/).join(', ')}]`)
      .replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n'
  )
}

export function fromBase64(text: string) {
  const binary = atob(text.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export const toBase64Ascii = (text: string) => btoa(text)

export type Totals = { sessions: number; messages: number; tokens: number; days: number }

export function totalsOf(days: Days): Totals {
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

export function compact(n: number) {
  for (const [size, suffix] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ] as const) {
    if (n >= size) return `${(n / size).toFixed(1).replace(/\.0$/, '')}${suffix}`
  }
  return String(n)
}

// Reading transcripts for days before the plugin was installed (`/usage-sync import`).
export type ImportState = {
  days: Days
  seenSessions: Set<string>
  seenResponses: Set<string>
  seenPrompts: Set<string>
}

export const newImport = (): ImportState => ({
  days: {},
  seenSessions: new Set(),
  seenResponses: new Set(),
  seenPrompts: new Set(),
})

type TranscriptEntry = {
  type?: string
  timestamp?: string
  sessionId?: string
  uuid?: string
  isMeta?: boolean
  requestId?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

// Mirrors what the live hooks count: a prompt or tool result is a message, and each model
// response is one message with its usage. Responses repeat once per content block, so they are
// counted by message id; resumed sessions replay earlier user entries, counted by uuid.
export function importLine(state: ImportState, line: string, before: number, timeZone: string) {
  if (!line.includes('"timestamp"')) return
  let entry: TranscriptEntry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (!entry.timestamp || (entry.type !== 'user' && entry.type !== 'assistant')) return
  const ms = Date.parse(entry.timestamp)
  if (Number.isNaN(ms) || ms >= before) return
  const { day, hour } = localDayAndHour(ms, timeZone)
  const bucket = (state.days[day] ??= emptyDay())

  if (entry.sessionId && !state.seenSessions.has(entry.sessionId)) {
    state.seenSessions.add(entry.sessionId)
    bucket.sessions++
  }

  if (entry.type === 'user') {
    if (entry.isMeta || (entry.uuid && state.seenPrompts.has(entry.uuid))) return
    if (entry.uuid) state.seenPrompts.add(entry.uuid)
    bucket.messages++
    return
  }

  const usage = entry.message?.usage
  const model = entry.message?.model
  if (!usage || !model || model === '<synthetic>') return
  const key = entry.message?.id ? `${entry.message.id}:${entry.requestId ?? ''}` : entry.uuid
  if (key === undefined || state.seenResponses.has(key)) return
  state.seenResponses.add(key)
  bucket.messages++
  bucket.hours[hour] = (bucket.hours[hour] ?? 0) + 1
  const totals = (bucket.models[model] ??= emptyModel())
  totals.input += usage.input_tokens ?? 0
  totals.output += usage.output_tokens ?? 0
  totals.cacheRead += usage.cache_read_input_tokens ?? 0
  totals.cacheWrite += usage.cache_creation_input_tokens ?? 0
  totals.requests++
}

// `owner/name`, as typed or pasted as a URL.
export function repoOf(value: string) {
  const match = value.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

export const reasonOf = (text: string) => {
  try {
    const parsed = JSON.parse(text) as { message?: string }
    if (parsed.message) return parsed.message
  } catch {
    // not JSON
  }
  return text.trim().split('\n')[0]?.slice(0, 200) ?? ''
}
