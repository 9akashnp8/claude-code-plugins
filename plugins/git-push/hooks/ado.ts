import type { BuildFailure, FailedBuild, PullRequest } from '../types'

// Azure DevOps Server 2020 and later, and Azure DevOps Services, all answer 6.0; a newer version is refused by older servers.
const API = 'api-version=6.0'
const POLICY_API = 'api-version=6.0-preview.1'

// How often an open pull request's status is asked again.
export const PULL_POLL_MS = 30_000

// How much of a failed step's log goes to Claude: its last lines, each step's share capped.
export const LOG_TAIL_LINES = 150
const LOG_CHARS = 6000
const ERRORS_PER_STEP = 10
// The first failures are usually the cause; the rest follow from them.
const FAILED_STEPS = 5

export type AdoRepo = { collection: string; project: string; repo: string }

export type AdoRequest = { method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown }

export type AdoResponse = { status: number; text: string }

// How a request signs in: the stored git credential sent as Basic (a PAT), the same credential
// through Windows sign-in (a domain password), or the Windows session's own account.
export type AuthMode = 'basic' | 'windows' | 'default'

export type RawPullRequest = {
  pullRequestId: number
  title: string
  status: string
  isDraft?: boolean
  mergeStatus?: string
  repository?: { project?: { id?: string } }
  reviewers?: { displayName: string; vote: number; isContainer?: boolean }[]
}

// A build validation policy's evaluation names, in context.buildId, the build it last queued: requeued or rerun
// after a push, the same evaluation names the new build. "Retry failed stages" reruns inside the same build.
export type RawEvaluation = {
  evaluationId?: string
  status: string
  configuration?: { isEnabled?: boolean }
  context?: { buildId?: unknown }
}

export type RawBuild = { id: number; buildNumber?: string; definition?: { name?: string } }

export type RawTimelineRecord = {
  type: string
  name: string
  result?: string | null
  order?: number
  log?: { id: number } | null
  issues?: { type: string; message?: string }[] | null
}

export type RawLog = { id: number; lineCount?: number }

// https://server/tfs/Collection/Project/_git/Repo, https://dev.azure.com/org/Project/_git/Repo or
// https://org.visualstudio.com/Project/_git/Repo; a user name before the host is dropped.
export function adoRepoOf(remote: string): AdoRepo | null {
  let url: URL
  try {
    url = new URL(remote.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const parts = url.pathname.split('/').filter(part => part !== '')
  const at = parts.indexOf('_git')
  const [project, repo] = [parts[at - 1], parts[at + 1]]
  if (at < 1 || project === undefined || repo === undefined) return null

  return {
    collection: [url.origin, ...parts.slice(0, at - 1)].join('/'),
    project: decodeURIComponent(project),
    repo: decodeURIComponent(repo),
  }
}

const projectUrl = (repo: AdoRepo) => `${repo.collection}/${encodeURIComponent(repo.project)}`
const repoApi = (repo: AdoRepo) => `${projectUrl(repo)}/_apis/git/repositories/${encodeURIComponent(repo.repo)}`

export const repositoryUrl = (repo: AdoRepo) => `${repoApi(repo)}?${API}`
export const createPullUrl = (repo: AdoRepo) => `${repoApi(repo)}/pullrequests?${API}`
export const pullUrl = (repo: AdoRepo, id: number) => `${repoApi(repo)}/pullrequests/${id}?${API}`
export const pullWebUrl = (repo: AdoRepo, id: number) =>
  `${projectUrl(repo)}/_git/${encodeURIComponent(repo.repo)}/pullrequest/${id}`
// The newest pull request from the branch, in any status.
export const findPullUrl = (repo: AdoRepo, branch: string) =>
  `${repoApi(repo)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}` +
  `&searchCriteria.status=all&$top=1&${API}`
export const evaluationsUrl = (repo: AdoRepo, projectId: string, id: number) =>
  `${projectUrl(repo)}/_apis/policy/evaluations?artifactId=` +
  `${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${id}`)}&${POLICY_API}`
// A PATCH queues the evaluation's build again, as the pull request's Re-queue button does.
export const requeueUrl = (repo: AdoRepo, evaluationId: string) =>
  `${projectUrl(repo)}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}?${POLICY_API}`

const buildApi = (repo: AdoRepo, buildId: number) => `${projectUrl(repo)}/_apis/build/builds/${buildId}`
export const buildUrl = (repo: AdoRepo, buildId: number) => `${buildApi(repo, buildId)}?${API}`
export const buildWebUrl = (repo: AdoRepo, buildId: number) => `${projectUrl(repo)}/_build/results?buildId=${buildId}`
export const timelineUrl = (repo: AdoRepo, buildId: number) => `${buildApi(repo, buildId)}/timeline?${API}`
export const logsUrl = (repo: AdoRepo, buildId: number) => `${buildApi(repo, buildId)}/logs?${API}`
// The id is the timeline record's log.id, not the step's place in the job.
export const logUrl = (repo: AdoRepo, buildId: number, logId: number, startLine: number) =>
  `${buildApi(repo, buildId)}/logs/${logId}?startLine=${startLine}&${API}`

export const branchOfRef = (ref: string) => ref.replace(/^refs\/heads\//, '')

// 203 is how Azure DevOps answers an anonymous request with its sign-in page.
export const isRefused = (response: AdoResponse | undefined) => response?.status === 401 || response?.status === 203

export function errorOf(response: AdoResponse) {
  if (isRefused(response)) return 'Azure DevOps refused the sign-in: check the credentials git uses for this server'
  try {
    const { message } = JSON.parse(response.text) as { message?: unknown }
    if (typeof message === 'string' && message !== '') return `Azure DevOps: ${message}`
  } catch {
    // Not JSON: an HTML error page.
  }
  // A proxy or web server's page: its text, markup dropped, says what was wrong.
  const page = response.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

  return page === '' ? `Azure DevOps answered ${response.status}` : `Azure DevOps answered ${response.status}: ${page}`
}

export function jsonOf<T>(response: AdoResponse): T {
  if (response.status < 200 || response.status >= 300) throw new Error(errorOf(response))

  return JSON.parse(response.text) as T
}

const FAILED = ['rejected', 'broken']

export function toPullRequest(
  raw: RawPullRequest,
  repo: AdoRepo,
  branch: string,
  evaluations: readonly RawEvaluation[],
): PullRequest {
  const people = (raw.reviewers ?? []).filter(reviewer => reviewer.isContainer !== true)
  const enabled = evaluations.filter(one => one.configuration?.isEnabled !== false)
  const count = (statuses: string[]) => enabled.filter(one => statuses.includes(one.status)).length
  const status = raw.status === 'completed' || raw.status === 'abandoned' ? raw.status : 'active'
  const failedBuilds = enabled.flatMap((one): FailedBuild[] =>
    FAILED.includes(one.status) && typeof one.context?.buildId === 'number' && one.evaluationId !== undefined
      ? [{ evaluationId: one.evaluationId, buildId: one.context.buildId }]
      : [],
  )

  return {
    id: raw.pullRequestId,
    title: raw.title,
    url: pullWebUrl(repo, raw.pullRequestId),
    branch,
    projectId: raw.repository?.project?.id ?? '',
    status,
    isDraft: raw.isDraft === true,
    hasConflicts: raw.mergeStatus === 'conflicts',
    approved: people.filter(reviewer => reviewer.vote >= 5).length,
    reviewers: people.length,
    rejectedBy: people.filter(reviewer => reviewer.vote <= -10).map(reviewer => reviewer.displayName),
    changesRequestedBy: people.filter(reviewer => reviewer.vote === -5).map(reviewer => reviewer.displayName),
    checks: {
      passed: count(['approved']),
      failed: count(FAILED),
      running: count(['queued', 'running']),
    },
    failedBuilds,
  }
}

// One failed build's key: a rerun of it that fails again is a new failure only once it was seen running.
export const failureKey = (one: FailedBuild) => `${one.evaluationId}:${one.buildId}`

// The failed steps of a build's timeline, in the order they ran. A job or stage counts only for the errors it
// carries itself, such as no agent picking it up; otherwise it failed because a step in it did.
export function failedStepsOf(records: readonly RawTimelineRecord[]) {
  return records
    .filter(record => record.result === 'failed')
    .map(record => ({
      record,
      errors: (record.issues ?? [])
        .filter(issue => issue.type === 'error' && typeof issue.message === 'string' && issue.message.trim() !== '')
        .map(issue => (issue.message ?? '').trim())
        .slice(0, ERRORS_PER_STEP),
    }))
    .filter(({ record, errors }) => record.type === 'Task' || errors.length > 0)
    .sort((a, b) => (a.record.order ?? 0) - (b.record.order ?? 0))
    .slice(0, FAILED_STEPS)
}

// Azure DevOps stamps each line with the time; Claude needs the text.
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/

// A log answers as {count, value: lines} when JSON is asked for; a server that sends plain text is split.
export function logLinesOf(response: AdoResponse) {
  if (response.status < 200 || response.status >= 300) return []
  try {
    const { value } = JSON.parse(response.text) as { value?: unknown }
    if (Array.isArray(value)) return value.map(String)
  } catch {
    // Plain text.
  }

  return response.text.split('\n')
}

export function tailOf(lines: readonly string[]) {
  const text = lines
    .map(line => line.replace(/\r$/, '').replace(TIMESTAMP, ''))
    .slice(-LOG_TAIL_LINES)
    .join('\n')
    .trim()

  return text.length > LOG_CHARS ? text.slice(-LOG_CHARS) : text
}

// Where a step's log tail starts: the first of its last LOG_TAIL_LINES lines.
export const tailStart = (log: RawLog | undefined) => Math.max(1, (log?.lineCount ?? 0) - LOG_TAIL_LINES + 1)

// What failed, in a form that stays the same when the same steps fail with the same first error again.
export const signatureOf = (failures: readonly BuildFailure[]) =>
  failures
    .flatMap(failure => failure.steps.map(step => `${failure.definition}/${step.name}: ${step.errors[0] ?? ''}`))
    .join('\n')

export type Tone = 'merged' | 'error' | 'warning' | 'success' | 'quiet'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// The line the band shows after "PR #12", and the color it takes.
export function summaryOf(pull: PullRequest): { text: string; tone: Tone } {
  if (pull.status === 'completed') return { text: 'Merged', tone: 'merged' }
  if (pull.status === 'abandoned') return { text: 'Abandoned', tone: 'quiet' }
  const { checks } = pull
  const parts = [pull.isDraft ? 'Draft' : 'Active']
  if (pull.hasConflicts) parts.push('has conflicts')
  if (pull.rejectedBy.length > 0) parts.push(`rejected by ${pull.rejectedBy.join(', ')}`)
  if (pull.changesRequestedBy.length > 0) parts.push(`changes requested by ${pull.changesRequestedBy.join(', ')}`)
  if (pull.reviewers > 0) parts.push(`${pull.approved} of ${pull.reviewers} approved`)
  if (checks.failed > 0) parts.push(`${plural(checks.failed, 'check')} failed`)
  else if (checks.running > 0) parts.push('checks running')
  else if (checks.passed > 0) parts.push('checks passed')
  const isBlocked = pull.hasConflicts || pull.rejectedBy.length > 0 || checks.failed > 0
  const isApproved = pull.reviewers > 0 && pull.approved === pull.reviewers && checks.running === 0

  return {
    text: parts.join(' · '),
    tone: isBlocked ? 'error' : pull.changesRequestedBy.length > 0 ? 'warning' : isApproved ? 'success' : 'quiet',
  }
}

// Windows PowerShell 5.1 sends the requests, so a domain password or the Windows session can sign in,
// which a fetch cannot. The credential arrives on stdin, never on the command line; stdin and stdout
// are read and written as UTF-8 bytes whatever the console's code page.
const REQUESTS = `
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::Expect100Continue = $false
$buffer = New-Object IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($buffer)
$in = [Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
$out = @(foreach ($r in $in.requests) {
  $p = @{ Uri = $r.url; Method = $r.method; UseBasicParsing = $true; Headers = @{ Accept = 'application/json' } }
  if ($r.body) { $p.Body = [Text.Encoding]::UTF8.GetBytes($r.body); $p.ContentType = 'application/json; charset=utf-8' }
  if ($in.auth -eq 'basic') {
    $p.Headers.Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($in.user + ':' + $in.password))
  } elseif ($in.auth -eq 'windows') {
    $p.Credential = New-Object Management.Automation.PSCredential($in.user, (ConvertTo-SecureString $in.password -AsPlainText -Force))
  } else {
    $p.UseDefaultCredentials = $true
  }
  try {
    $w = Invoke-WebRequest @p
    @{ status = [int]$w.StatusCode; text = [string]$w.Content }
  } catch [Net.WebException] {
    $x = $_.Exception.Response
    if ($null -eq $x) { throw }
    # Invoke-WebRequest has already drained the response stream by now: the body is in ErrorDetails.
    $t = ''
    if ($_.ErrorDetails) { $t = [string]$_.ErrorDetails.Message }
    if ($t -eq '') {
      try {
        $s = $x.GetResponseStream()
        if ($s.CanSeek) { $s.Position = 0 }
        $t = (New-Object IO.StreamReader($s)).ReadToEnd()
      } catch { }
    }
    @{ status = [int]$x.StatusCode; text = $t }
  }
})
$bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $out -Compress -Depth 3))
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
`

// -EncodedCommand takes the script as base64 of its UTF-16LE text: no quoting of it on the command line.
function encodedCommand(script: string) {
  let binary = ''
  for (let i = 0; i < script.length; i += 1) {
    const code = script.charCodeAt(i)
    binary += String.fromCharCode(code & 0xff, code >> 8)
  }

  return btoa(binary)
}

export const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(REQUESTS)]

export type Credential = { user: string; password: string }

export const requestsInput = (auth: AuthMode, credential: Credential | null, requests: readonly AdoRequest[]) =>
  JSON.stringify({
    auth,
    user: credential?.user ?? '',
    password: credential?.password ?? '',
    requests: requests.map(({ method, url, body }) => ({
      method,
      url,
      body: body === undefined ? null : JSON.stringify(body),
    })),
  })

// git credential fill answers key=value lines; a credential needs at least a password.
export function credentialOf(stdout: string): Credential | null {
  const fields = new Map(
    stdout
      .split('\n')
      .map(line => line.replace(/\r$/, ''))
      .filter(line => line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  )
  const password = fields.get('password') ?? ''

  return password === '' ? null : { user: fields.get('username') ?? '', password }
}

export function responsesOf(stdout: string): AdoResponse[] {
  const parsed = JSON.parse(stdout) as AdoResponse | AdoResponse[]

  return Array.isArray(parsed) ? parsed : [parsed]
}
