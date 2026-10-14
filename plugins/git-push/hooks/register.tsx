import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import type { BuildFailure, FailedBuild, PullFix, PullRequest, Unpushed } from '../types'
import {
  adoRepoOf,
  branchOfRef,
  buildUrl,
  buildWebUrl,
  createPullUrl,
  credentialOf,
  errorOf,
  evaluationsUrl,
  failedStepsOf,
  failureKey,
  findPullUrl,
  isRefused,
  jsonOf,
  logLinesOf,
  logsUrl,
  logUrl,
  POWERSHELL,
  PULL_POLL_MS,
  pullUrl,
  repositoryUrl,
  requestsInput,
  requeueUrl,
  responsesOf,
  signatureOf,
  summaryOf,
  tailOf,
  tailStart,
  timelineUrl,
  toPullRequest,
  type AdoRepo,
  type AdoRequest,
  type AdoResponse,
  type AuthMode,
  type Credential,
  type RawBuild,
  type RawEvaluation,
  type RawLog,
  type RawPullRequest,
  type RawTimelineRecord,
} from './ado'
import {
  basesOf,
  BRANCH_DISTANCES,
  CHANGES,
  describe,
  distancesOf,
  failureOf,
  FETCH,
  FETCH_TIMEOUT_MS,
  isSame,
  linesOf,
  MERGE_HEAD,
  mergeOf,
  NEW_COMMITS,
  POLL_MS,
  PUSH,
  PUSH_TIMEOUT_MS,
  REMOTE,
  UNMERGED,
} from './git'
import {
  conflictHeader,
  conflictPrompt,
  draftPrompt,
  fixHeader,
  fixPrompt,
  outcomeOf,
  parseDraft,
  revisePrompt,
} from './prompts'

type Engine = EngineInterface

const PANE = 'git-push'

const unpushed = atom({ plugin: 'git-push', key: 'unpushed' } as const, null)
const isPushing = atom({ plugin: 'git-push', key: 'isPushing' } as const, false)
const readyBranch = atom({ plugin: 'git-push', key: 'readyBranch' } as const, null)
const pull = atom({ plugin: 'git-push', key: 'pull' } as const, null)
const draft = atom({ plugin: 'git-push', key: 'draft' } as const, null)
const bases = atom({ plugin: 'git-push', key: 'bases' } as const, [])
const busy = atom({ plugin: 'git-push', key: 'busy' } as const, null)
const notice = atom({ plugin: 'git-push', key: 'notice' } as const, null)
const fix = atom({ plugin: 'git-push', key: 'fix' } as const, null)
const escalation = atom({ plugin: 'git-push', key: 'escalation' } as const, null)

type Branch = { branch: string; isPublished: boolean; ahead: number; remote: string; repo: AdoRepo | null }

// What git said last; the pull request poll reads it rather than asking git again.
let current: Branch | null = null
// Held in memory only, never in $.state or the store.
let credential: Credential | null | undefined
let authMode: AuthMode | undefined
const defaultBranches = new Map<string, string>()
// Typed into the title field and not yet submitted.
let typedTitle: string | undefined
// The failed builds a fix was started for, by failureKey, and the conflicts, by conflictKey: no second button for
// one until it is seen not failing, as when a build is queued again or Azure DevOps tries the merge again.
const handled = new Set<string>()
// The fix turn in flight, known by the prompt's first line once it starts.
type FixTurn = {
  kind: PullFix['kind']
  header: string
  turnId?: string
  isSubmitted: boolean
  pullId: number
  branch: string
  // What the fix is for, as handled holds it.
  keys: string[]
  // A build fix's builds, and what failed in them.
  failed: FailedBuild[]
  signature: string
}
let fixTurn: FixTurn | null = null
// What the last fix was for, so the same failure coming back is said to Claude.
let lastFix: { pullId: number; signature: string } | null = null

// GIT_TERMINAL_PROMPT and GCM_INTERACTIVE: fail rather than wait on a prompt nobody can answer.
// GIT_OPTIONAL_LOCKS: the poll never holds the index lock against a commit in progress.
const git = ($: Engine, args: string[], init: { timeoutMs?: number; stdin?: string } = {}) =>
  $.process.run(['git', ...args], {
    env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' },
    ...init,
  })

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function branchOf($: Engine): Promise<Branch | null> {
  const head = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = head.stdout.trim()
  if (head.exitCode !== 0 || branch === 'HEAD') return null
  const origin = await git($, ['remote', 'get-url', REMOTE])
  if (origin.exitCode !== 0) return null
  const remote = origin.stdout.trim()

  // A worktree branched from origin/main may track origin/main; that is not this branch on origin.
  const tracked = await git($, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const isPublished = tracked.exitCode === 0 && tracked.stdout.trim() === `${REMOTE}/${branch}`
  const count = await git($, isPublished ? ['rev-list', '--count', '@{u}..HEAD'] : NEW_COMMITS)
  const ahead = count.exitCode === 0 ? Number(count.stdout.trim()) || 0 : 0

  return { branch, isPublished, ahead, remote, repo: adoRepoOf(remote) }
}

let refreshing: Promise<void> | null = null

function refresh($: Engine) {
  refreshing ??= (async () => {
    const before = current
    current = await branchOf($).catch(() => null)
    const found: Unpushed | null =
      current !== null && current.ahead > 0
        ? { branch: current.branch, isPublished: current.isPublished, ahead: current.ahead }
        : null
    if (!isSame(await read($, unpushed), found)) await update($, unpushed, () => found)
    const ready = current?.isPublished && current.ahead === 0 && current.repo !== null ? current.branch : null
    if ((await read($, readyBranch)) !== ready) await update($, readyBranch, () => ready)
    if (before?.branch !== current?.branch || before?.isPublished !== current?.isPublished) void refreshPull($)
  })().finally(() => {
    refreshing = null
  })

  return refreshing
}

async function push($: Engine) {
  if (await read($, isPushing)) return
  const pending = await read($, unpushed)
  await update($, isPushing, () => true)
  try {
    const { exitCode, stderr } = await git($, PUSH, { timeoutMs: PUSH_TIMEOUT_MS })
    $.ui.toast(exitCode === 0 ? `Pushed ${pending?.branch ?? 'HEAD'} to ${REMOTE}` : `Push failed: ${failureOf(stderr)}`)
  } catch (error) {
    $.ui.toast(`Push failed: ${message(error)}`)
  } finally {
    await update($, isPushing, () => false)
    await refresh($)
    void refreshPull($)
  }
}

// The credential git would send to the remote: a PAT or a password, from whatever helper stores it.
async function credentialFor($: Engine, remote: string) {
  if (credential === undefined) {
    const filled = await git($, ['credential', 'fill'], { stdin: `url=${remote}\n\n` }).catch(() => null)
    credential = filled?.exitCode === 0 ? credentialOf(filled.stdout) : null
  }

  return credential
}

async function send($: Engine, auth: AuthMode, found: Credential | null, requests: readonly AdoRequest[]) {
  const { exitCode, stdout, stderr } = await $.process.run(POWERSHELL, {
    stdin: requestsInput(auth, found, requests),
    timeoutMs: 60_000,
  })
  if (exitCode !== 0) throw new Error(`could not reach Azure DevOps: ${stderr.trim().split('\n')[0] ?? ''}`)

  return responsesOf(stdout)
}

// Tries each way of signing in until one is not refused, then keeps to it.
async function ado($: Engine, remote: string, requests: readonly AdoRequest[]): Promise<AdoResponse[]> {
  const found = await credentialFor($, remote)
  const modes: AuthMode[] =
    authMode !== undefined ? [authMode] : found !== null ? ['basic', 'windows', 'default'] : ['default']
  let responses: AdoResponse[] = []
  for (const mode of modes) {
    responses = await send($, mode, found, requests)
    if (!isRefused(responses[0])) {
      authMode = mode
      return responses
    }
  }
  // Refused even the way that worked before: the credential may have changed, so look it up again next time.
  credential = undefined
  authMode = undefined

  return responses
}

const first = (responses: AdoResponse[]): AdoResponse => responses[0] ?? { status: 0, text: '' }

async function setPull($: Engine, next: PullRequest | null) {
  if (JSON.stringify(await read($, pull)) !== JSON.stringify(next)) await update($, pull, () => next)
}

async function loadPull($: Engine, branch: Branch & { repo: AdoRepo }, known: PullRequest | null) {
  const { repo } = branch
  if (known === null) {
    const search = await ado($, branch.remote, [{ method: 'GET', url: findPullUrl(repo, branch.branch) }])
    const raw = jsonOf<{ value: RawPullRequest[] }>(first(search)).value[0]
    if (raw === undefined) return null
    known = toPullRequest(raw, repo, branch.branch, [])
    if (known.status !== 'active') return known
  }
  const [answer, checks] = await ado($, branch.remote, [
    { method: 'GET', url: pullUrl(repo, known.id) },
    { method: 'GET', url: evaluationsUrl(repo, known.projectId, known.id) },
  ])
  const raw = jsonOf<RawPullRequest>(answer ?? first([]))
  // Policies are a nicety: a server that will not list them still shows the rest.
  const evaluations = checks?.status === 200 ? (JSON.parse(checks.text) as { value: RawEvaluation[] }).value : []

  return toPullRequest(raw, repo, branch.branch, evaluations)
}

let pulling: Promise<void> | null = null

// Finds the branch's newest pull request, then follows it until it is merged or abandoned.
function refreshPull($: Engine) {
  pulling ??= (async () => {
    const branch = current
    if (branch === null || !branch.isPublished || branch.repo === null) return setPull($, null)
    const shown = await read($, pull)
    const known = shown?.branch === branch.branch ? shown : null
    if (known !== null && known.status !== 'active') return
    // Quiet: the poll runs every 30 seconds, and a failure shows when the person next acts.
    const loaded = await loadPull($, { ...branch, repo: branch.repo }, known).catch(() => known)
    await forgetPassed($, loaded)
    await setPull($, loaded)
  })().finally(() => {
    pulling = null
  })

  return pulling
}

// A failure no longer failing is forgotten, and what Claude said a person must do about it with it.
async function forgetPassed($: Engine, shown: PullRequest | null) {
  const failing = new Set([...(shown?.failedBuilds ?? []).map(failureKey), ...(shown?.conflictKey ? [shown.conflictKey] : [])])
  for (const key of handled) if (!failing.has(key)) handled.delete(key)
  const said = await read($, escalation)
  if (said !== null && !said.keys.some(key => failing.has(key))) await update($, escalation, () => null)
}

// The build's failed steps, each with its errors and the end of its log, in two calls.
async function readFailure($: Engine, branch: Branch & { repo: AdoRepo }, buildId: number): Promise<BuildFailure> {
  const { repo, remote } = branch
  const [build, timeline, logs] = await ado($, remote, [
    { method: 'GET', url: buildUrl(repo, buildId) },
    { method: 'GET', url: timelineUrl(repo, buildId) },
    { method: 'GET', url: logsUrl(repo, buildId) },
  ])
  const raw = jsonOf<RawBuild>(build ?? first([]))
  const records = jsonOf<{ records?: RawTimelineRecord[] | null }>(timeline ?? first([])).records ?? []
  // The list of logs only says where each tail starts; without it, a log is read whole and cut.
  const counts = logs?.status === 200 ? ((JSON.parse(logs.text) as { value?: RawLog[] }).value ?? []) : []
  const failed = failedStepsOf(records).map(step => ({ ...step, logId: step.record.log?.id }))
  const logged = failed.flatMap(step => (step.logId === undefined ? [] : [step.logId]))
  const tails =
    logged.length === 0
      ? []
      : await ado(
          $,
          remote,
          logged.map(logId => ({
            method: 'GET' as const,
            url: logUrl(repo, buildId, logId, tailStart(counts.find(log => log.id === logId))),
          })),
        )

  return {
    buildId,
    definition: raw.definition?.name ?? `build ${buildId}`,
    url: buildWebUrl(repo, buildId),
    steps: failed.map(({ record, errors, logId }) => {
      const tail = logId === undefined ? undefined : tails[logged.indexOf(logId)]
      return { name: record.name, errors, log: tail === undefined ? '' : tailOf(logLinesOf(tail)) }
    }),
  }
}

// The pull request a fix starts from: on the branch checked out, with no other fix running.
async function fixable($: Engine) {
  const [branch, shown] = [readyOf(current), await read($, pull)]
  const isFree = (await read($, fix)) === null

  return branch !== null && shown !== null && shown.branch === branch.branch && isFree ? { branch, shown } : null
}

// Hands the prompt to Claude as a turn of its own; finishFix takes it from there.
async function submitFix($: Engine, turn: FixTurn, text: string) {
  fixTurn = turn
  await update($, fix, () => ({ kind: turn.kind, stage: 'fixing' }))
  await $.prompt.submit({ text })
  turn.isSubmitted = true
  turn.keys.forEach(key => handled.add(key))
}

// Reads what failed for Claude to fix.
async function startBuildFix($: Engine) {
  const found = await fixable($)
  if (found === null) return
  const { branch, shown } = found
  const failed = shown.failedBuilds.filter(one => !handled.has(failureKey(one)))
  if (failed.length === 0) return
  await update($, fix, () => ({ kind: 'build', stage: 'reading' }))
  await update($, escalation, () => null)
  try {
    const failures: BuildFailure[] = []
    for (const one of failed) failures.push(await readFailure($, branch, one.buildId))
    const signature = signatureOf(failures)
    const isRepeat = lastFix?.pullId === shown.id && lastFix.signature === signature
    const turn: FixTurn = {
      kind: 'build',
      header: fixHeader(shown.id),
      isSubmitted: false,
      pullId: shown.id,
      branch: branch.branch,
      keys: failed.map(failureKey),
      failed,
      signature,
    }
    await submitFix($, turn, fixPrompt({ pullId: shown.id, branch: branch.branch, failures, isRepeat }))
  } catch (error) {
    fixTurn = null
    await update($, fix, () => null)
    $.ui.toast(`Could not read the failed build: ${message(error)}`)
  }
}

// Merges the target in here, then hands the files in conflict to Claude. A merge already in progress is picked up
// as it stands, so a fix that left one unfinished can be finished.
async function startConflictFix($: Engine) {
  const found = await fixable($)
  if (found === null) return
  const { branch, shown } = found
  const key = shown.conflictKey
  if (key === null || handled.has(key) || shown.target === '') return
  await update($, fix, () => ({ kind: 'conflicts', stage: 'merging' }))
  await update($, escalation, () => null)
  let isMergedClean = false
  try {
    if ((await git($, MERGE_HEAD)).exitCode !== 0) {
      if (linesOf((await git($, CHANGES)).stdout).length > 0) {
        throw new Error('commit or stash your changes first, so the merge holds nothing else')
      }
      const fetched = await git($, FETCH, { timeoutMs: FETCH_TIMEOUT_MS })
      if (fetched.exitCode !== 0) throw new Error(failureOf(fetched.stderr))
      const merged = await git($, mergeOf(shown.target), { timeoutMs: FETCH_TIMEOUT_MS })
      if (merged.exitCode === 0) {
        // Git merged it alone, as Azure DevOps could not: nothing for Claude to resolve.
        handled.add(key)
        $.ui.toast(`Merged ${REMOTE}/${shown.target} with no conflicts here; pushing it`)
        await refresh($)
        isMergedClean = true
        await update($, fix, () => ({ kind: 'conflicts', stage: 'pushing' }))
        await push($)
        return
      }
      if ((await git($, MERGE_HEAD)).exitCode !== 0) throw new Error(failureOf(merged.stderr))
    }
    const files = linesOf((await git($, UNMERGED)).stdout)
    const turn: FixTurn = {
      kind: 'conflicts',
      header: conflictHeader(shown.id),
      isSubmitted: false,
      pullId: shown.id,
      branch: branch.branch,
      keys: [key],
      failed: [],
      signature: '',
    }
    await submitFix($, turn, conflictPrompt({ pullId: shown.id, branch: branch.branch, target: shown.target, files }))
  } catch (error) {
    fixTurn = null
    $.ui.toast(`Could not fix the conflicts: ${message(error)}`)
  } finally {
    if (isMergedClean || fixTurn === null) await update($, fix, () => null)
  }
}

const SUBJECT = { build: 'The build', conflicts: 'The conflicts' } as const

// After the fix turn: Claude's commit is pushed, RETRY queues the build again, ESCALATE is shown and notified.
async function finishFix($: Engine, e: TurnCompleteInput) {
  const done = fixTurn
  fixTurn = null
  if (done === null) return
  const { keys } = done
  // The button comes back for a fix that did not finish or committed nothing.
  const offerAgain = () => keys.forEach(key => handled.delete(key))
  const subject = SUBJECT[done.kind]
  try {
    if (e.reason !== 'answer') {
      offerAgain()
      $.ui.toast(`${subject} fix stopped before it finished`)
      return
    }
    if (done.kind === 'build') lastFix = { pullId: done.pullId, signature: done.signature }
    const outcome = outcomeOf(e.answer)
    if (outcome.kind === 'escalate') {
      await update($, escalation, () => ({ reason: outcome.reason, keys }))
      const title = `${subject} ${done.kind === 'build' ? 'needs' : 'need'} you`
      await $.ui.notify(`PR #${done.pullId}: ${outcome.reason}`, { title }).catch(() => undefined)
      return
    }
    await refresh($)
    const branch = readyOf(current)
    if (branch === null || branch.branch !== done.branch) {
      offerAgain()
      $.ui.toast(`${subject} fix was left alone: ${done.branch} is no longer checked out`)
      return
    }
    if (done.kind === 'conflicts' && (await git($, MERGE_HEAD)).exitCode === 0) {
      offerAgain()
      $.ui.toast('Claude left the merge unfinished: Fix conflicts picks it up where it stopped')
      return
    }
    if (done.kind === 'build' && outcome.kind === 'retry') {
      const requeues = done.failed.map(one => ({ method: 'PATCH' as const, url: requeueUrl(branch.repo, one.evaluationId) }))
      const refused = (await ado($, branch.remote, requeues)).find(answer => answer.status < 200 || answer.status >= 300)
      if (refused !== undefined) offerAgain()
      $.ui.toast(
        refused === undefined
          ? `Queued the build again: ${outcome.reason}`
          : `Could not queue the build again: ${errorOf(refused)}`,
      )
      void refreshPull($)
      return
    }
    if (branch.ahead === 0) {
      offerAgain()
      $.ui.toast(done.kind === 'build' ? 'Claude committed no fix for the build' : 'Claude committed no merge')
      return
    }
    await update($, fix, () => ({ kind: done.kind, stage: 'pushing' }))
    await push($)
  } catch (error) {
    offerAgain()
    $.ui.toast(`${subject} fix failed: ${message(error)}`)
  } finally {
    await update($, fix, () => null)
  }
}

async function attempt($: Engine, label: string, work: () => Promise<void>) {
  await update($, busy, () => label)
  await update($, notice, () => null)
  try {
    await work()
  } catch (error) {
    await update($, notice, () => message(error))
  } finally {
    await update($, busy, () => null)
  }
}

// The fork reads this session's transcript; before the first reply there is none.
async function ask($: Engine, prompt: string) {
  const forked = await $.model.fork({ prompt })
  const reply =
    !forked.isAnswered && forked.reason === 'nothing-to-fork'
      ? await $.model.complete({ model: await $.session.model(), prompt })
      : forked
  if (!reply.isAnswered) throw new Error(`the model gave no draft (${reply.reason})`)

  return reply.text
}

async function defaultBranchOf($: Engine, branch: Branch & { repo: AdoRepo }) {
  const key = `${branch.repo.collection}/${branch.repo.project}/${branch.repo.repo}`
  const known = defaultBranches.get(key)
  if (known !== undefined) return known
  const answer = first(await ado($, branch.remote, [{ method: 'GET', url: repositoryUrl(branch.repo) }]))
  const target = branchOfRef(jsonOf<{ defaultBranch?: string }>(answer).defaultBranch ?? '')
  if (target === '') throw new Error('the repository has no default branch to merge into')
  defaultBranches.set(key, target)

  return target
}

const readyOf = (branch: Branch | null) =>
  branch?.isPublished && branch.repo !== null ? { ...branch, repo: branch.repo } : null

// The branches the pull request can merge into, the one the branch was most likely cut from first. Measured against
// origin as it is now: offline, as it was last fetched; with a git too old to measure, only the default branch.
async function basesFor($: Engine, branch: Branch & { repo: AdoRepo }) {
  const fallback = await defaultBranchOf($, branch)
  await git($, FETCH, { timeoutMs: FETCH_TIMEOUT_MS }).catch(() => undefined)
  const found = await git($, BRANCH_DISTANCES).catch(() => null)

  return found?.exitCode === 0 ? basesOf(distancesOf(found.stdout), branch.branch, fallback) : [fallback]
}

// Only the commits and files between the target and HEAD go in, so the draft describes this branch's work alone.
async function draftInto($: Engine, branch: Branch, target: string) {
  const commits = await git($, ['log', '--no-merges', '--format=- %s%n%w(0,2,2)%b', `${REMOTE}/${target}..HEAD`])
  const diffstat = await git($, ['diff', '--stat', `${REMOTE}/${target}...HEAD`])
  const prompt = draftPrompt({ branch: branch.branch, target, commits: commits.stdout, diffstat: diffstat.stdout })

  return parseDraft(await ask($, prompt), target)
}

async function startDraft($: Engine) {
  const branch = readyOf(current)
  if (branch === null) return
  typedTitle = undefined
  await update($, draft, () => null)
  await update($, bases, () => [])
  await $.ui.open({ id: PANE, title: 'Pull request', focus: true })
  await attempt($, 'Drafting the pull request...', async () => {
    const found = await basesFor($, branch)
    await update($, bases, () => found)
    const drafted = await draftInto($, branch, found[0] ?? '')
    await update($, draft, () => drafted)
  })
}

// Another target changes what the pull request holds, so the draft is written again.
async function retarget($: Engine, target: string) {
  const [branch, drafted] = [readyOf(current), await read($, draft)]
  if (branch === null || drafted === null || drafted.target === target || (await read($, busy)) !== null) return
  await attempt($, `Drafting the pull request into ${target}...`, async () => {
    const redrafted = await draftInto($, branch, target)
    typedTitle = undefined
    await update($, draft, () => redrafted)
  })
}

async function revise($: Engine, instruction: string) {
  const drafted = await read($, draft)
  if (drafted === null || instruction.trim() === '') return
  await attempt($, 'Revising...', async () => {
    const prompt = revisePrompt({ current: { ...drafted, title: typedTitle ?? drafted.title }, instruction })
    const revised = parseDraft(await ask($, prompt), drafted.target)
    typedTitle = undefined
    await update($, draft, () => revised)
  })
}

async function createPull($: Engine) {
  const [branch, drafted] = [readyOf(current), await read($, draft)]
  if (branch === null || drafted === null) return
  const title = (typedTitle ?? drafted.title).trim()
  if (title === '') {
    await update($, notice, () => 'The pull request needs a title.')
    return
  }
  await attempt($, 'Creating the pull request...', async () => {
    const body = {
      sourceRefName: `refs/heads/${branch.branch}`,
      targetRefName: `refs/heads/${drafted.target}`,
      title,
      description: drafted.description,
    }
    const answer = first(await ado($, branch.remote, [{ method: 'POST', url: createPullUrl(branch.repo), body }]))
    const created = toPullRequest(jsonOf<RawPullRequest>(answer), branch.repo, branch.branch, [])
    await setPull($, created)
    await update($, draft, () => null)
    typedTitle = undefined
    $.ui.toast(`Created PR #${created.id}: ${created.title}`)
    // Said in the conversation so Claude, and jira-log's update drafted from it, know the PR is up.
    const note = `I opened pull request #${created.id} "${created.title}" into ${drafted.target}: ${created.url}`
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } }).catch(() => undefined)
    await $.ui.close({ id: PANE })
    void refreshPull($)
  })
}

async function discard($: Engine) {
  typedTitle = undefined
  await update($, draft, () => null)
  await update($, bases, () => [])
  await update($, notice, () => null)
  await $.ui.close({ id: PANE })
}

const FIX_STAGES = {
  build: { reading: 'Reading the failed build…', fixing: 'Claude is fixing the build…' },
  conflicts: { merging: 'Merging the target branch in…', fixing: 'Claude is resolving the conflicts…' },
} as const

function stageOf({ kind, stage }: PullFix) {
  if (stage === 'pushing') return kind === 'build' ? 'Pushing the fix…' : 'Pushing the merge…'
  const stages: Partial<Record<PullFix['stage'], string>> = FIX_STAGES[kind]

  return stages[stage] ?? ''
}

const TONE_PROPS = {
  merged: { color: 'merged' },
  error: { color: 'error' },
  warning: { color: 'warning' },
  success: { color: 'success' },
  quiet: { dimColor: true },
} as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A fix whose turn this module no longer follows, after a reload, is over.
    await update($, fix, () => null)
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(PULL_POLL_MS, () => void refreshPull($))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (fixTurn !== null && fixTurn.turnId === undefined && e.text.includes(fixTurn.header)) fixTurn.turnId = e.turnId

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // The button is offered only while the session is idle, so the next turn to end is the fix's own even when its
    // start went unrecognised.
    const isFixTurn =
      e.agentId === undefined &&
      fixTurn !== null &&
      (e.turnId === fixTurn.turnId || (fixTurn.turnId === undefined && fixTurn.isSubmitted))
    if (isFixTurn) void finishFix($, e)
    else void refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const pending = await read($, unpushed)
    const pushing = await read($, isPushing)
    const ready = await read($, readyBranch)
    const shown = await read($, pull)
    const pr = shown !== null && shown.branch === current?.branch ? shown : null
    const canCreate = ready !== null && !pushing && (pr === null || pr.status === 'abandoned')
    const fixing = await read($, fix)
    const said = await read($, escalation)
    const canFix = pr !== null && pr.status === 'active' && fixing === null && !e.props.isWorking
    const canFixBuild = canFix && pr.failedBuilds.some(one => !handled.has(failureKey(one)))
    const canFixConflicts = canFix && pr.conflictKey !== null && pr.target !== '' && !handled.has(pr.conflictKey)
    if (pending === null && !pushing && pr === null && !canCreate) return next(e)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // The band holds one tree: stack what the plugins beneath draw (jira-log's line) under ours,
    // with a rule between. Nothing beneath leaves the engine's own band, which draws no line.
    const below = await next(e)
    const rule = below.type !== 'engine' && <Text dimColor wrap="truncate">{'─'.repeat(e.props.bodyColumns)}</Text>
    const summary = pr === null ? null : summaryOf(pr)
    const hasBranchPart = pending !== null || pushing || canCreate

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {pr !== null && <Link href={pr.url} label={`PR #${pr.id}`} />}
          {summary !== null && <Text {...TONE_PROPS[summary.tone]}>{summary.text}</Text>}
          {canFixConflicts && (
            <Button key="fix-conflicts" label="Fix conflicts" variant="primary" onPress={() => void startConflictFix($)} />
          )}
          {canFixBuild && (
            <Button key="fix-build" label="Fix build" variant="primary" onPress={() => void startBuildFix($)} />
          )}
          {pr !== null && fixing !== null && <Text dimColor>{stageOf(fixing)}</Text>}
          {pr !== null && hasBranchPart && <Text dimColor>·</Text>}
          {pending !== null && <Text dimColor>{describe(pending)}</Text>}
          {canCreate && pending === null && <Text dimColor>{ready} · on {REMOTE}</Text>}
          {pushing ? (
            <Text dimColor>Pushing…</Text>
          ) : (
            pending !== null && <Button key="push" label="Push" variant="primary" onPress={() => void push($)} />
          )}
          {canCreate && (
            <Button key="create-pr" label="Create PR" variant="primary" onPress={() => void startDraft($)} />
          )}
        </Box>
        {pr !== null && said !== null && <Text color="warning">{`Needs you: ${said.reason}`}</Text>}
        {rule}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The pull request pane needs the terminal or the desktop app.</Text>
    }
    const { Box, Button, Input, Markdown, Select, Text } = $.ui.resolve(e)
    const working = await read($, busy)
    const said = await read($, notice)
    const drafted = await read($, draft)
    const targets = await read($, bases)
    const branch = current?.branch ?? ''

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          {drafted === null ? `Pull request for ${branch}` : `${branch} → ${drafted.target}`}
        </Text>
        {drafted !== null && working === null && targets.length > 1 && (
          <Select
            key="target"
            label="Into   "
            options={targets.map(value => ({ value }))}
            value={drafted.target}
            onSelect={value => void retarget($, value)}
          />
        )}
        {drafted !== null && (
          <Input
            key="title"
            label="Title  "
            value={typedTitle ?? drafted.title}
            onInput={value => void (typedTitle = value)}
            onSubmit={value => void (typedTitle = value)}
          />
        )}
        {drafted !== null && <Markdown text={drafted.description || '_No description._'} />}
        {drafted !== null && working === null && (
          <Box flexDirection="column" gap={1}>
            <Input
              key="revise"
              label="Revise "
              placeholder="e.g. mention the new setting reviewers must add"
              submitLabel="revise"
              onSubmit={value => void revise($, value)}
            />
            <Box flexDirection="row" gap={2}>
              <Button key="create" label="Create pull request" variant="primary" onPress={() => void createPull($)} />
              <Button key="discard" label="Discard" role="dismiss" onPress={() => void discard($)} />
            </Box>
          </Box>
        )}
        {working !== null && <Text dimColor>{working}</Text>}
        {said !== null && <Text color="warning">{said}</Text>}
      </Box>
    )
  })
}
