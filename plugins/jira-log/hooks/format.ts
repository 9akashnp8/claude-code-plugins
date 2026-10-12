import type { JiraIssue, JiraNewIssue, JiraProgress, JiraSprint, JiraSuggestion, JiraTransition, JiraUpdate } from '../types'

export type JiraConfig = { site: string; email: string; tokenBlob: string; project?: string }

// Older comments carry no `actions` or `postedAt`, and their `update` holds completed, pending, blockers
// and achievements lists in place of `notes`.
export type DailyComment = { id: string; updated: string; update: JiraUpdate; actions?: number; postedAt?: number }

export type DayActivity = {
  files: string[]
  commits: string[]
  tests: { command: string; isPassing: boolean }[]
  // A pull or merge request's URL, or the command or tool that opened it when no URL was printed.
  pullRequests: string[]
  // Published Artifacts by URL; the title is empty when no publish named one. Absent on older days.
  artifacts?: { url: string; title: string }[]
  // Every action recorded today, counted even when the lists above dedupe or roll it off; absent on older days.
  actions?: number
}

// An earlier day posted under a later day's comment rather than one of its own.
export type CoveredDay = { actions: number; in: string }

export type UnpostedDay = { day: string; activity: DayActivity; actions: number; unposted: number }

export type RawIssue = {
  key: string
  fields: { summary: string; status: { name: string; statusCategory: { key: string } } }
}

export type RawComment = { id: string; updated: string }

export type RawTransition = { id: string; name: string; to: { name: string } }

export type RawSprint = { id: number; name: string; state: string }

export const IN_PROGRESS = 'In Progress'

export const EMPTY_ACTIVITY: DayActivity = {
  files: [],
  commits: [],
  tests: [],
  pullRequests: [],
  artifacts: [],
  actions: 0,
}

// How far back unposted work is still offered to the draft.
export const LOOKBACK_DAYS = 14

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const clockOf = (at: number) => {
  const date = new Date(at)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// What the band and status line say about the linked issue's work that is not in Jira yet.
export function progressOf(progress: JiraProgress | null, day: string) {
  const current = progress?.day === day ? progress : null
  const actions = current?.actions ?? 0
  const earlier = current?.earlier ?? 0
  const unposted = Math.max(0, actions - (current?.postedActions ?? 0)) + earlier
  if (current?.postedAt == null) {
    if (unposted === 0) return { tone: 'quiet', text: 'nothing recorded today', short: '' }
    const text =
      earlier === 0
        ? `${plural(actions, 'action')} today, not in Jira yet`
        : actions === 0
          ? `${plural(earlier, 'action')} from earlier days, not in Jira yet`
          : `${plural(actions, 'action')} today and ${earlier} earlier, not in Jira yet`

    return { tone: 'due', text, short: `${unposted} unposted` }
  }
  if (unposted === 0) {
    return { tone: 'done', text: `✓ today's update posted ${clockOf(current.postedAt)}`, short: '✓' }
  }

  return {
    tone: 'due',
    text: `posted ${clockOf(current.postedAt)}, ${plural(unposted, 'action')} ${earlier === 0 ? 'since' : 'not in Jira yet'}`,
    short: `${unposted} unposted`,
  }
}

export const TEST_RUN =
  /\b(pytest|vitest|jest|mocha|unittest|go test|cargo test|(?:npm|pnpm|yarn|bun)(?: run)? test)\b/
export const COMMIT = /\bgit\s+commit\b/
const REVIEW_COMMAND = /\b(gh\s+pr\s+create|glab\s+mr\s+create|az\s+repos\s+pr\s+create)\b/
const REVIEW_TOOL = /create_?(?:pull_?request|merge_?request)/i
// GitHub /pull/7, GitLab /merge_requests/7, Azure DevOps /pullrequest/7.
const REVIEW_URL = /https?:\/\/[^\s"'<>]+\/(?:pull|merge_requests|pullrequest)\/\d+/
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/

// DPAPI: a sealed blob opens only for this Windows user on this machine.
export const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command']
export const SEAL =
  '$t = [Console]::In.ReadToEnd().Trim(); ' +
  'ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString'
export const OPEN =
  '$b = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString -String $b; ' +
  '[Runtime.InteropServices.Marshal]::PtrToStringBSTR(' +
  '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'

export const UPDATE_RULES = [
  'Rules: these are plain notes, not sections. A weekly report is built from them later and sorts the work ' +
    'into its own sections, so never group or label the notes.',
  '- 2 to 6 notes, in the order the work happened, each one line of at most 25 words.',
  '- Each note says what was done and what it achieved. When something went wrong, say what and how it was ' +
    'resolved, or that it is still open and who or what it waits on.',
  '- Mention a next step only when it was decided today.',
  '- Never narrate the session, list files, names or terms, or mention housekeeping such as committing or pushing.',
  '- Plain words a teammate outside the project understands. No code, diffs, file paths, secrets or internal ' +
    'hostnames. Never invent anything.',
].join('\n')

export const UPDATE_SHAPE = 'Answer with only this JSON object and nothing else:\n{"notes": []}'

export const UPDATE_AND_MOVE_SHAPE =
  'Answer with only this JSON object and nothing else:\n{"notes": [], "move": {"to": "", "reason": ""}}'

export const ISSUE_SHAPE =
  'Answer with only this JSON object and nothing else:\n{"summary": "", "description": ""}'

export function newIssuePrompt(focus: string) {
  const subject = focus
    ? `The person asked for: "${focus}". That decides what the ticket is about. Use this conversation ` +
      'only for details that serve it, and leave out everything else the conversation covered.'
    : 'Base it on the main piece of work in this conversation.'

  return [
    'Draft a Jira ticket: a description of work to be done, not a record of what this conversation did.',
    subject,
    [
      'Rules:',
      '- Write it as work ahead, for a teammate who has not seen the conversation. Never narrate what was ' +
        'discussed, tried or found, or what exists so far.',
      '- summary: an imperative title under 80 characters.',
      '- description: 2 to 4 plain sentences: the outcome wanted, why, and how to tell it is done. No ' +
        'headings or lists.',
      '- Under 120 words in all. No code, file paths, diffs, secrets or internal hostnames.',
    ].join('\n'),
    ISSUE_SHAPE,
  ].join('\n\n')
}

export function reviewRequestOf(command: string, output: string) {
  const opened = command.match(REVIEW_COMMAND)?.[1]

  return opened === undefined ? undefined : (output.match(REVIEW_URL)?.[0] ?? opened.replace(/\s+/g, ' '))
}

export const isReviewTool = (tool: string) => tool.startsWith('mcp__') && REVIEW_TOOL.test(tool)

export const reviewUrlIn = (output: string) => output.match(REVIEW_URL)?.[0]

type ArtifactCall = { action?: string; asset?: boolean; url?: string; title?: string }

// A publish of a page or its files, not an asset upload. A create names its URL only in what it answered,
// and an update names its page's title only there.
export function publishedArtifactOf(input: ArtifactCall, result: unknown, output: string) {
  if ((input.action ?? 'publish') !== 'publish' || input.asset === true) return undefined
  const answered = (typeof result === 'object' && result !== null ? result : {}) as { url?: unknown; title?: unknown }
  const url = [input.url, answered.url, output]
    .map(one => (typeof one === 'string' ? one.match(ARTIFACT_URL)?.[0] : undefined))
    .find(one => one !== undefined)
  const title = [input.title, answered.title].find(one => typeof one === 'string' && one.trim() !== '')

  return url === undefined ? undefined : { url, title: typeof title === 'string' ? title.trim() : '' }
}

export function addArtifact(list: DayActivity['artifacts'] = [], artifact: { url: string; title: string }) {
  const known = list.find(one => one.url === artifact.url)
  if (known === undefined) return [...list, artifact].slice(-50)
  if (known.title !== '' || artifact.title === '') return list

  return list.map(one => (one === known ? artifact : one))
}

export const toTransition = ({ id, name, to }: RawTransition): JiraTransition => ({ id, name, to: to.name })

export const isSameStatus = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export const toIssue = ({ key, fields }: RawIssue): JiraIssue => ({
  key,
  summary: fields.summary,
  status: fields.status.name,
  statusCategory: fields.status.statusCategory.key,
})

export function reasonOf(text: string) {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> }
    const reasons = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})]
    if (reasons.length > 0) return reasons.join('; ')
  } catch {}

  return text.slice(0, 200)
}

export function dayOf(now: number) {
  const date = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dayBefore(day: string, count: number) {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)

  return dayOf(new Date(year, month - 1, date - count).getTime())
}

// The earlier days within the lookback, oldest first, that the store holds activity for on this issue.
export function earlierDaysIn(keys: readonly string[], issue: string, day: string) {
  const prefix = `activity:${issue}:`
  const oldest = dayBefore(day, LOOKBACK_DAYS)

  return keys
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length))
    .filter(one => one >= oldest && one < day)
    .sort()
}

export function relativeTo(root: string, path: string) {
  const [file, base] = [path.replaceAll('\\', '/'), `${root.replaceAll('\\', '/')}/`]

  return file.toLowerCase().startsWith(base.toLowerCase()) ? file.slice(base.length) : file
}

export const addOnce = (list: string[], item: string, limit: number) =>
  list.includes(item) ? list : [...list, item].slice(-limit)

const objectIn = (reply: string) => JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1))

const listOf = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    : []

// The ticket's text only: its type and sprint are picked in the form, not by the model.
export function parseNewIssue(reply: string): Pick<JiraNewIssue, 'summary' | 'description'> {
  const parsed = objectIn(reply) as { summary?: unknown; description?: unknown }
  const summary = typeof parsed.summary === 'string' ? cappedSummary(parsed.summary.trim()) : ''
  if (summary === '') throw new Error('the model drafted no summary')

  return { summary, description: typeof parsed.description === 'string' ? parsed.description.trim() : '' }
}

// Only a move the workflow allows from here is suggested; anything else the model names is dropped.
export function parseSuggestion(
  reply: string,
  moves: readonly JiraTransition[],
  status: string,
): JiraSuggestion | null {
  const { move } = objectIn(reply) as { move?: { to?: unknown; reason?: unknown } }
  const to = typeof move?.to === 'string' ? move.to : ''
  const transition = moves.find(one => isSameStatus(one.to, to))
  if (to === '' || transition === undefined || isSameStatus(to, status)) return null

  return { id: transition.id, to: transition.to, reason: typeof move?.reason === 'string' ? move.reason.trim() : '' }
}

export function parseUpdate(reply: string): JiraUpdate {
  return { notes: listOf((objectIn(reply) as { notes?: unknown }).notes) }
}

export const toMarkdown = (update: JiraUpdate) =>
  update.notes.map(note => `- ${note}`).join('\n') || '_Nothing to report._'

const SUMMARY_LIMIT = 255

// A ticket the person writes themselves starts blank; only the summary is required.
export const emptyIssue = (issueType: string, sprint: number | null = null): JiraNewIssue => ({
  summary: '',
  description: '',
  issueType,
  sprint,
})

export const isIssueReady = (issue: JiraNewIssue) => issue.summary.trim() !== ''

export const cappedSummary = (summary: string) => summary.slice(0, SUMMARY_LIMIT)

// The open sprints of the project's boards, each once: the active ones first, then the future ones.
export function toSprints(lists: readonly (readonly RawSprint[])[]): JiraSprint[] {
  const open = new Map<number, JiraSprint>()
  for (const { id, name, state } of lists.flat()) {
    if (!open.has(id) && (state === 'active' || state === 'future')) open.set(id, { id, name, state })
  }
  const sprints = [...open.values()]

  return [...sprints.filter(one => one.state === 'active'), ...sprints.filter(one => one.state === 'future')]
}

// A new issue goes into the current sprint unless the person picks another one, or the backlog.
export const currentSprint = (sprints: readonly JiraSprint[]) =>
  sprints.find(one => one.state === 'active')?.id ?? null

const BACKLOG = 'backlog'

export const sprintOptions = (sprints: readonly JiraSprint[]) => [
  ...sprints.map(one => ({ value: String(one.id), label: one.state === 'active' ? `${one.name} (current)` : one.name })),
  { value: BACKLOG, label: 'Backlog' },
]

export const sprintValue = (sprint: number | null) => (sprint === null ? BACKLOG : String(sprint))

export const sprintOf = (value: string) => (value === BACKLOG ? null : Number(value))

const text = (value: string, isStrong = false) =>
  isStrong ? { type: 'text', text: value, marks: [{ type: 'strong' }] } : { type: 'text', text: value }

const bulletList = (items: readonly string[]) => ({
  type: 'bulletList',
  content: items.map(item => ({ type: 'listItem', content: [{ type: 'paragraph', content: [text(item)] }] })),
})

// Comment and description bodies in the v3 API are Atlassian Document Format, not markdown.
export function toDocument(day: string, update: JiraUpdate) {
  const notes = update.notes.length > 0 ? [bulletList(update.notes)] : []

  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [text(`Daily update ${day}`, true)] }, ...notes],
  }
}

// Each line of the description is a paragraph of its own.
export function toIssueDocument(issue: JiraNewIssue) {
  const lines = issue.description.split('\n').map(line => line.trim()).filter(Boolean)

  return { type: 'doc', version: 1, content: lines.map(line => ({ type: 'paragraph', content: [text(line)] })) }
}
