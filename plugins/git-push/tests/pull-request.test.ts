import { expect, mock, test } from 'claude-code/testing'

import { adoRepoOf, PULL_POLL_MS, summaryOf, toPullRequest } from '../hooks/ado'
import { activePull, ADO_REMOTE, BAND, fakeGit, PANE, SESSION } from './fake'

const PUSHED = { upstream: 'origin/feature/export', ahead: 0, remote: ADO_REMOTE }
const PAT = 'username=me\npassword=pat-secret\n'
const DRAFT = JSON.stringify({ title: 'CPC-7: Add export', description: 'Adds CSV export.\n\n#### Changes\n- Export endpoint' })

test('the remote names the collection, project and repository', () => {
  expect(adoRepoOf('https://devops.example.com/tfs/Applications/Data%20Platform/_git/workplace')).toEqual({
    collection: 'https://devops.example.com/tfs/Applications',
    project: 'Data Platform',
    repo: 'workplace',
  })
  expect(adoRepoOf('https://me@dev.azure.com/team/Platform/_git/api')).toEqual({
    collection: 'https://dev.azure.com/team',
    project: 'Platform',
    repo: 'api',
  })
  expect(adoRepoOf('https://team.visualstudio.com/Platform/_git/api')?.collection).toBe('https://team.visualstudio.com')
  expect(adoRepoOf('https://github.com/team/repo.git')).toBeNull()
  expect(adoRepoOf('git@ssh.dev.azure.com:v3/team/Platform/api')).toBeNull()
})

test('a pushed branch offers a pull request, drafted from the session and created once reviewed', async ($, on) => {
  const { server, ran, toasts, prompts, clock } = fakeGit(on, { ...PUSHED, credential: PAT }, { drafts: [DRAFT] })
  const session = mock.session(on)
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await band.find({ type: 'Text', text: /on origin/ }))?.text).toBe('feature/export · on origin')
  await band.press({ key: 'create-pr' })
  await clock.settle()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(prompts[0]).toContain('merging branch "feature/export" into "main"')
  expect(prompts[0]).toContain('Add the export endpoint')
  expect((await pane.find({ key: 'title' }))?.props.value).toBe('CPC-7: Add export')

  await pane.input({ key: 'title', text: 'CPC-7: Add the CSV export', kind: 'change' })
  await pane.press({ key: 'create' })
  await clock.settle()

  const created = server.requests.find(request => request.method === 'POST')
  expect(created?.url).toBe(
    'https://devops.example.com/tfs/Applications/Data%20Platform/_apis/git/repositories/workplace/pullrequests?api-version=6.0',
  )
  expect(created?.body).toEqual({
    sourceRefName: 'refs/heads/feature/export',
    targetRefName: 'refs/heads/main',
    title: 'CPC-7: Add the CSV export',
    description: 'Adds CSV export.\n\n#### Changes\n- Export endpoint',
  })
  expect(toasts).toContain('Created PR #101: CPC-7: Add the CSV export')
  expect(session.appended().map(row => row.message.content)).toEqual([
    [
      {
        type: 'text',
        text:
          'I opened pull request #101 "CPC-7: Add the CSV export" into main: ' +
          'https://devops.example.com/tfs/Applications/Data%20Platform/_git/workplace/pullrequest/101',
      },
    ],
  ])
  expect(await band.find({ key: 'create-pr' })).toBeUndefined()
  expect((await band.find({ type: 'Link' }))?.props).toEqual({
    href: 'https://devops.example.com/tfs/Applications/Data%20Platform/_git/workplace/pullrequest/101',
    label: 'PR #101',
  })
  // The credential travels on PowerShell's stdin only.
  expect(ran.some(command => command.includes('pat-secret'))).toBe(false)
  await pane.unmount()
  await band.unmount()
})

test('the line follows the pull request until it is merged', async ($, on) => {
  const pull = activePull({
    reviewers: [
      { displayName: 'Priya', vote: 10 },
      { displayName: 'Omar', vote: 0 },
      { displayName: '[Platform]\\Contributors', vote: 0, isContainer: true },
    ],
  })
  const { clock } = fakeGit(on, { ...PUSHED, credential: PAT }, {
    server: { pulls: [pull], evaluations: [{ status: 'running' }, { status: 'approved' }] },
  })
  await $.session.start({ ...SESSION, surface: 'desktop' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await band.find({ type: 'Link' }))?.props.label).toBe('PR #7')
  expect((await band.find({ type: 'Text', text: /Active/ }))?.text).toBe('Active · 1 of 2 approved · checks running')
  expect(await band.find({ key: 'create-pr' })).toBeUndefined()

  pull.status = 'completed'
  await clock.advance(PULL_POLL_MS)

  const merged = await band.find({ type: 'Text', text: 'Merged' })
  expect(merged?.props.color).toBe('merged')
  await band.unmount()
})

test('a password that Basic sign-in refuses is tried through Windows sign-in, which is then kept', async ($, on) => {
  const { server, clock } = fakeGit(on, { ...PUSHED, credential: 'username=CPC\\me\npassword=domain-password\n' }, {
    server: { accepts: ['windows'], pulls: [activePull()] },
  })
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await clock.settle()
  await clock.advance(PULL_POLL_MS)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await band.find({ type: 'Link' }))?.props.label).toBe('PR #7')
  const auths = server.requests.map(request => request.auth)
  expect(auths[0]).toBe('basic')
  expect(auths.slice(1).every(auth => auth === 'windows')).toBe(true)
  await band.unmount()
})

test('with no stored credential, requests sign in as the Windows user', async ($, on) => {
  const { server, clock } = fakeGit(on, PUSHED, { server: { accepts: ['default'], pulls: [activePull()] } })
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await band.find({ type: 'Link' }))?.props.label).toBe('PR #7')
  expect(server.requests.every(request => request.auth === 'default')).toBe(true)
  await band.unmount()
})

test('a pull request Azure DevOps refuses says why in the pane', async ($, on) => {
  const refusal = 'TF401179: An active pull request for the source and target branch already exists.'
  const { clock } = fakeGit(on, { ...PUSHED, credential: PAT }, {
    drafts: [DRAFT],
    server: { refuseCreate: { status: 409, message: refusal } },
  })
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'create-pr' })
  await clock.settle()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.press({ key: 'create' })
  await clock.settle()

  expect((await pane.find({ type: 'Text', text: /TF401179/ }))?.text).toBe(`Azure DevOps: ${refusal}`)
  expect(await pane.find({ key: 'create' })).toBeDefined()
  await pane.unmount()
  await band.unmount()
})

test('a blocked pull request reads as an error, one waiting on its author as a warning', () => {
  const repo = adoRepoOf(ADO_REMOTE)!
  const of = (fields: Parameters<typeof activePull>[0], evaluations = [] as { status: string }[]) =>
    summaryOf(toPullRequest(activePull(fields), repo, 'feature/export', evaluations))

  expect(of({ mergeStatus: 'conflicts' })).toEqual({ text: 'Active · has conflicts', tone: 'error' })
  expect(of({}, [{ status: 'rejected' }])).toEqual({ text: 'Active · 1 check failed', tone: 'error' })
  expect(of({ reviewers: [{ displayName: 'Priya', vote: -5 }] })).toEqual({
    text: 'Active · changes requested by Priya · 0 of 1 approved',
    tone: 'warning',
  })
  expect(of({ isDraft: true, reviewers: [{ displayName: 'Priya', vote: 10 }] }, [{ status: 'approved' }])).toEqual({
    text: 'Draft · 1 of 1 approved · checks passed',
    tone: 'success',
  })
  expect(of({ status: 'abandoned' })).toEqual({ text: 'Abandoned', tone: 'quiet' })
})
