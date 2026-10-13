import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PullRequest, Unpushed } from '../types'
import {
  adoRepoOf,
  branchOfRef,
  createPullUrl,
  credentialOf,
  evaluationsUrl,
  findPullUrl,
  isRefused,
  jsonOf,
  POWERSHELL,
  PULL_POLL_MS,
  pullUrl,
  repositoryUrl,
  requestsInput,
  responsesOf,
  summaryOf,
  toPullRequest,
  type AdoRepo,
  type AdoRequest,
  type AdoResponse,
  type AuthMode,
  type Credential,
  type RawEvaluation,
  type RawPullRequest,
} from './ado'
import {
  basesOf,
  BRANCH_DISTANCES,
  describe,
  distancesOf,
  failureOf,
  FETCH,
  FETCH_TIMEOUT_MS,
  isSame,
  NEW_COMMITS,
  POLL_MS,
  PUSH,
  PUSH_TIMEOUT_MS,
  REMOTE,
} from './git'
import { draftPrompt, parseDraft, revisePrompt } from './prompts'

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

type Branch = { branch: string; isPublished: boolean; ahead: number; remote: string; repo: AdoRepo | null }

// What git said last; the pull request poll reads it rather than asking git again.
let current: Branch | null = null
// Held in memory only, never in $.state or the store.
let credential: Credential | null | undefined
let authMode: AuthMode | undefined
const defaultBranches = new Map<string, string>()
// Typed into the title field and not yet submitted.
let typedTitle: string | undefined

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
    // Quiet: the poll runs every minute, and a failure shows when the person next acts.
    const loaded = await loadPull($, { ...branch, repo: branch.repo }, known).catch(() => known)
    await setPull($, loaded)
  })().finally(() => {
    pulling = null
  })

  return pulling
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

const TONE_PROPS = {
  merged: { color: 'merged' },
  error: { color: 'error' },
  warning: { color: 'warning' },
  success: { color: 'success' },
  quiet: { dimColor: true },
} as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(PULL_POLL_MS, () => void refreshPull($))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)

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
