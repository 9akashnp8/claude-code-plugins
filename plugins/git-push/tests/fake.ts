import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import type { AuthMode, RawEvaluation, RawPullRequest, RawTimelineRecord } from '../hooks/ado'

export type Repo = {
  branch: string
  upstream: string | null
  ahead: number
  pushError: string | null
  remote: string
  // What git credential fill prints; empty when no helper holds one.
  credential: string
  // What git for-each-ref prints for origin's branches: "<name> <its commits HEAD lacks> <HEAD's commits it lacks>".
  // Null for a git too old to know %(ahead-behind).
  remoteBranches: string | null
}

export type Server = {
  accepts: AuthMode[]
  pulls: RawPullRequest[]
  evaluations: RawEvaluation[]
  // A POST of a pull request gets this answer instead of creating one.
  refuseCreate: { status: number; message: string } | null
  // The builds the evaluations name, by id: the pipeline's name, its timeline, and each log's lines by log id.
  builds: Record<number, { definition: string; records: RawTimelineRecord[]; logs: Record<number, string[]> }>
  // The evaluations a PATCH queued again.
  requeued: string[]
  requests: { auth: string; method: string; url: string; body: Record<string, unknown> | null }[]
}

export const ADO_REMOTE = 'https://devops.example.com/tfs/Applications/Data%20Platform/_git/workplace'

export const BAND = {
  plugin: 'git-push',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

export const PANE = {
  plugin: 'git-push',
  component: 'Pane',
  requestId: 'git-push',
  props: { title: 'Pull request', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

export const SESSION = { cwd: 'C:\\code\\repo', isInteractive: true } as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export const activePull = (fields: Partial<RawPullRequest> = {}): RawPullRequest => ({
  pullRequestId: 7,
  title: 'CPC-7: Add export',
  status: 'active',
  mergeStatus: 'succeeded',
  repository: { project: { id: 'project-1' } },
  reviewers: [],
  ...fields,
})

type Options = { isBeneathDrawn?: boolean; server?: Partial<Server>; drafts?: string[] }

// Stands in for git, Azure DevOps (through PowerShell), the model and the session beneath the plugin.
// A push publishes the branch unless pushError is set; the server refuses a way of signing in it does not accept.
export function fakeGit(on: On, start: Partial<Repo> = {}, { isBeneathDrawn = true, server: serverStart = {}, drafts = [] }: Options = {}) {
  const repo: Repo = {
    branch: 'feature/export',
    upstream: 'origin/main',
    ahead: 2,
    pushError: null,
    remote: 'https://github.com/team/repo.git',
    credential: '',
    remoteBranches: ['HEAD 0 0', 'feature/export 0 0', 'main 0 2'].join('\n'),
    ...start,
  }
  const server: Server = {
    accepts: ['basic'],
    pulls: [],
    evaluations: [],
    refuseCreate: null,
    builds: {},
    requeued: [],
    requests: [],
    ...serverStart,
  }
  const ran: string[] = []
  const toasts: string[] = []
  const prompts: string[] = []
  // What the plugin submitted as turns of their own, and the notifications it raised.
  const submitted: string[] = []
  const notified: string[] = []
  const clock = mock.clock(on)
  const answer = (exitCode: number, stdout = '', stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) })

  function serve(auth: string, method: string, url: string, body: Record<string, unknown> | null) {
    server.requests.push({ auth, method, url, body })
    if (!server.accepts.includes(auth as AuthMode)) return { status: 401, text: '' }
    const id = Number(url.match(/\/pullrequests\/(\d+)\?/)?.[1])
    if (method === 'POST' && url.includes('/pullrequests?')) {
      if (server.refuseCreate !== null) return json(server.refuseCreate.status, { message: server.refuseCreate.message })
      const created = activePull({ pullRequestId: 101 + server.pulls.length, title: String(body?.title) })
      server.pulls.push(created)
      return json(201, created)
    }
    const requeue = url.match(/\/policy\/evaluations\/([^/?]+)\?/)
    if (method === 'PATCH' && requeue !== null) {
      server.requeued.push(decodeURIComponent(requeue[1] ?? ''))
      return json(200, {})
    }
    const buildRoute = url.match(/\/_apis\/build\/builds\/(\d+)(\/timeline|\/logs\/(\d+)|\/logs)?\?(?:startLine=(\d+))?/)
    if (buildRoute !== null) {
      const build = server.builds[Number(buildRoute[1])]
      if (build === undefined) return json(404, { message: `no build ${buildRoute[1]}` })
      const [, , part, logId, startLine] = buildRoute
      if (part === '/timeline') return json(200, { records: build.records })
      if (part === '/logs') {
        return json(200, { value: Object.entries(build.logs).map(([id, lines]) => ({ id: Number(id), lineCount: lines.length })) })
      }
      if (logId !== undefined) {
        const lines = (build.logs[Number(logId)] ?? []).slice(Number(startLine ?? 1) - 1)
        return json(200, { count: lines.length, value: lines })
      }
      return json(200, { id: Number(buildRoute[1]), definition: { name: build.definition } })
    }
    if (url.includes('/pullrequests?searchCriteria')) return json(200, { value: server.pulls.slice(-1) })
    if (!Number.isNaN(id)) return json(200, server.pulls.find(one => one.pullRequestId === id))
    if (url.includes('/policy/evaluations')) return json(200, { value: server.evaluations })
    if (url.includes('/_apis/git/repositories/')) return json(200, { defaultBranch: 'refs/heads/main' })
    return json(404, { message: `no route for ${method} ${url}` })
  }

  on('process.run', ($, e) => {
    const command = e.argv.slice(1).join(' ')
    ran.push(e.argv.join(' '))
    if (e.argv[0] === 'powershell.exe') {
      const input = JSON.parse(e.init?.stdin ?? '{}') as {
        auth: string
        requests: { method: string; url: string; body: string | null }[]
      }
      const responses = input.requests.map(request =>
        serve(input.auth, request.method, request.url, request.body === null ? null : JSON.parse(request.body)),
      )
      return answer(0, JSON.stringify(responses))
    }
    if (command === 'rev-parse --abbrev-ref HEAD') return answer(0, `${repo.branch}\n`)
    if (command === 'remote get-url origin') return answer(0, `${repo.remote}\n`)
    if (command.endsWith('@{u}')) {
      return repo.upstream === null ? answer(128, '', 'fatal: no upstream') : answer(0, `${repo.upstream}\n`)
    }
    if (command.startsWith('rev-list --count')) return answer(0, `${repo.ahead}\n`)
    if (command === 'credential fill') {
      return repo.credential === '' ? answer(128, '', 'fatal: terminal prompts disabled') : answer(0, repo.credential)
    }
    if (command === 'fetch --prune origin') return answer(0)
    if (command.startsWith('for-each-ref')) {
      return repo.remoteBranches === null
        ? answer(128, '', 'fatal: unknown field name: ahead-behind:HEAD')
        : answer(0, repo.remoteBranches)
    }
    if (command.startsWith('log ')) return answer(0, '- Add the export endpoint\n  Streams rows as CSV.\n')
    if (command.startsWith('diff --stat')) return answer(0, ' src/export.ts | 40 ++++\n')
    if (command.startsWith('push')) {
      if (repo.pushError !== null) return answer(1, '', repo.pushError)
      repo.upstream = `origin/${repo.branch}`
      repo.ahead = 0
      return answer(0, '', `To ${repo.remote}\n`)
    }
    return answer(1, '', `unexpected: git ${command}`)
  })
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: drafts.shift() ?? '{}', usage: USAGE } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.notify', ($, e) => {
    notified.push(e.text)
    return { value: { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  // What the plugins beneath draw in the band, such as jira-log's line; else the engine's own, empty band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) =>
    isBeneathDrawn ? $.ui.resolve(e).Box({ key: 'beneath' }) : { type: 'engine' as const, ref: 0 },
  )

  return { repo, server, ran, toasts, prompts, submitted, notified, clock }
}
