import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { failedStepsOf, PULL_POLL_MS, tailOf } from '../hooks/ado'
import type { RawEvaluation, RawTimelineRecord } from '../hooks/ado'
import { outcomeOf } from '../hooks/prompts'
import { activePull, ADO_REMOTE, BAND, fakeGit, SESSION } from './fake'

const PUSHED = { upstream: 'origin/feature/export', ahead: 0, remote: ADO_REMOTE, credential: 'username=me\npassword=pat\n' }
const FAILED: RawEvaluation = { evaluationId: 'eval-1', status: 'rejected', context: { buildId: 8621 } }
const RUNNING: RawEvaluation = { evaluationId: 'eval-1', status: 'running', context: { buildId: 8621 } }

const stamp = (line: string) => `2026-10-14T10:00:00.0000000Z ${line}`
const RECORDS: RawTimelineRecord[] = [
  // A stage fails because a step in it did, and says nothing of its own.
  { type: 'Stage', name: 'Build', result: 'failed', order: 1, issues: null },
  { type: 'Task', name: 'Checkout', result: 'succeeded', order: 1, log: { id: 3 } },
  {
    type: 'Task',
    name: 'dotnet test',
    result: 'failed',
    order: 5,
    log: { id: 15 },
    issues: [
      { type: 'warning', message: 'Slow test run' },
      { type: 'error', message: 'Process completed with exit code 1.' },
    ],
  },
]
const LOG = [...Array.from({ length: 200 }, (_, i) => stamp(`line ${i + 1}`)), stamp('##[error]ExportTests.Streams failed')]
const BUILDS = { 8621: { definition: 'CPC-PR-Validation', records: RECORDS, logs: { 3: [stamp('ok')], 15: LOG } } }

const complete = (turnId: string, answer: string) =>
  ({ answer, durationMs: 1000, isAborted: false, turnId, reason: 'answer' }) as const

async function failingPull($: Engine, on: On) {
  const fake = fakeGit(on, PUSHED, { server: { pulls: [activePull()], evaluations: [FAILED], builds: BUILDS } })
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await fake.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  return { ...fake, band }
}

test('a failed build is handed to Claude with its errors and the end of its log, and the fix is pushed', async ($, on) => {
  const { repo, server, submitted, toasts, ran, clock, band } = await failingPull($, on)

  expect((await band.find({ type: 'Text', text: /check failed/ }))?.text).toBe('Active · 1 check failed')
  await band.press({ key: 'fix-build' })
  await clock.settle()

  const prompt = submitted[0] ?? ''
  expect(prompt.startsWith('The validation build of pull request #7 failed.')).toBe(true)
  expect(prompt).toContain('Build 8621 of "CPC-PR-Validation"')
  expect(prompt).toContain('Data%20Platform/_build/results?buildId=8621')
  expect(prompt).toContain('Step "dotnet test" failed.')
  expect(prompt).toContain('Process completed with exit code 1.')
  expect(prompt).not.toContain('Slow test run')
  expect(prompt).not.toContain('Step "Build"')
  // The last 150 lines, from line 52, without their timestamps.
  expect(prompt).toContain('line 52\nline 53')
  expect(prompt).not.toContain('line 51\n')
  expect(prompt).toContain('line 200\n##[error]ExportTests.Streams failed')
  expect(prompt).not.toContain('2026-10-14T')
  expect(prompt).toContain('"fix(ci): "')
  expect(server.requests.some(request => request.url.includes('/logs/15?startLine=52&'))).toBe(true)
  expect((await band.find({ type: 'Text', text: /fixing/ }))?.text).toBe('Claude is fixing the build…')
  expect(await band.find({ key: 'fix-build' })).toBeUndefined()

  await $.turn.start({ text: prompt, turnId: 'fix-1' })
  repo.ahead = 1
  await $.turn.complete(complete('fix-1', 'The export test expected a header row. Fixed and committed.'))
  await clock.settle()

  expect(ran).toContain('git push --set-upstream origin HEAD')
  expect(toasts).toContain('Pushed feature/export to origin')
  expect(await band.find({ type: 'Text', text: /fixing|Pushing/ })).toBeUndefined()
  // The same build, still failed, is not offered again.
  expect(await band.find({ key: 'fix-build' })).toBeUndefined()
  await band.unmount()
})

test('a build that fails the same way again after a fix is offered again, and Claude is told', async ($, on) => {
  const { repo, server, submitted, clock, band } = await failingPull($, on)
  await band.press({ key: 'fix-build' })
  await clock.settle()
  await $.turn.start({ text: submitted[0] ?? '', turnId: 'fix-1' })
  repo.ahead = 1
  await $.turn.complete(complete('fix-1', 'Fixed.'))
  await clock.settle()

  // Retrying its failed stages reruns the same build: it is seen running, then failed again.
  server.evaluations = [RUNNING]
  await clock.advance(PULL_POLL_MS)
  expect(await band.find({ key: 'fix-build' })).toBeUndefined()
  server.evaluations = [FAILED]
  await clock.advance(PULL_POLL_MS)
  await band.press({ key: 'fix-build' })
  await clock.settle()

  expect(submitted[1]).toContain('A fix for this same failure was already pushed')
  expect(submitted[0]).not.toContain('A fix for this same failure was already pushed')
  await band.unmount()
})

test('a failure only a person can fix is shown and notified, and nothing is pushed', async ($, on) => {
  const { repo, server, submitted, notified, ran, clock, band } = await failingPull($, on)
  await band.press({ key: 'fix-build' })
  await clock.settle()
  await $.turn.start({ text: submitted[0] ?? '', turnId: 'fix-1' })
  repo.ahead = 1
  await $.turn.complete(
    complete('fix-1', 'The test needs a database the agent has no access to.\n\n**ESCALATE:** Add the CPC_DB variable group to the pipeline.'),
  )
  await clock.settle()

  const reason = 'Add the CPC_DB variable group to the pipeline.'
  expect((await band.find({ type: 'Text', text: /Needs you/ }))?.text).toBe(`Needs you: ${reason}`)
  expect(notified).toEqual([`PR #7: ${reason}`])
  expect(ran.some(command => command.startsWith('git push'))).toBe(false)

  // Once the build runs again the warning is gone.
  server.evaluations = [{ ...RUNNING, context: { buildId: 8622 } }]
  await clock.advance(PULL_POLL_MS)
  expect(await band.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  await band.unmount()
})

test('a failure outside the code queues the build again', async ($, on) => {
  const { server, submitted, toasts, clock, band } = await failingPull($, on)
  await band.press({ key: 'fix-build' })
  await clock.settle()
  await $.turn.start({ text: submitted[0] ?? '', turnId: 'fix-1' })
  await $.turn.complete(complete('fix-1', 'The agent lost its connection to the feed.\nRETRY: the NuGet feed timed out'))
  await clock.settle()

  expect(server.requeued).toEqual(['eval-1'])
  const patch = server.requests.find(request => request.method === 'PATCH')
  expect(patch?.url).toBe(
    'https://devops.example.com/tfs/Applications/Data%20Platform/_apis/policy/evaluations/eval-1?api-version=6.0-preview.1',
  )
  expect(toasts).toContain('Queued the build again: the NuGet feed timed out')
  await band.unmount()
})

test('a fix that is interrupted or commits nothing offers the button again', async ($, on) => {
  const { submitted, toasts, ran, clock, band } = await failingPull($, on)
  await band.press({ key: 'fix-build' })
  await clock.settle()
  await $.turn.start({ text: submitted[0] ?? '', turnId: 'fix-1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'fix-1', reason: 'aborted' })
  await clock.settle()

  expect(toasts).toContain('The build fix stopped before it finished')
  expect(await band.find({ key: 'fix-build' })).toBeDefined()

  await band.press({ key: 'fix-build' })
  await clock.settle()
  await $.turn.start({ text: submitted[1] ?? '', turnId: 'fix-2' })
  await $.turn.complete(complete('fix-2', 'I could not reproduce it.'))
  await clock.settle()

  expect(toasts).toContain('Claude committed no fix for the build')
  expect(ran.some(command => command.startsWith('git push'))).toBe(false)
  expect(await band.find({ key: 'fix-build' })).toBeDefined()
  await band.unmount()
})

test('the button waits while Claude is working', async ($, on) => {
  const { clock } = fakeGit(on, PUSHED, { server: { pulls: [activePull()], evaluations: [FAILED], builds: BUILDS } })
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })

  expect(await band.find({ key: 'fix-build' })).toBeUndefined()
  await band.unmount()
})

test('failed steps keep their errors; a job or stage counts only for errors of its own', () => {
  const records: RawTimelineRecord[] = [
    { type: 'Task', name: 'Lint', result: 'failed', order: 3, log: { id: 9 } },
    { type: 'Job', name: 'Agent job', result: 'failed', order: 1, issues: [{ type: 'error', message: 'No agent found in pool' }] },
    { type: 'Stage', name: 'Build', result: 'failed', order: 1 },
    { type: 'Task', name: 'Restore', result: 'succeeded', order: 2, log: { id: 8 } },
  ]

  expect(failedStepsOf(records).map(({ record, errors }) => [record.name, errors])).toEqual([
    ['Agent job', ['No agent found in pool']],
    ['Lint', []],
  ])
  expect(tailOf(['2026-10-14T10:00:00.1234567Z first\r', 'second'])).toBe('first\nsecond')
})

test('the reply says whether to retry or escalate by its last marked line', () => {
  expect(outcomeOf('Fixed the test and committed.')).toEqual({ kind: 'fixed' })
  expect(outcomeOf('Not a code problem.\nESCALATE: grant the build service access')).toEqual({
    kind: 'escalate',
    reason: 'grant the build service access',
  })
  expect(outcomeOf('**RETRY:** agent went offline')).toEqual({ kind: 'retry', reason: 'agent went offline' })
  expect(outcomeOf('RETRY: flaky\n\nOn second look:\nESCALATE: the secret expired')).toEqual({
    kind: 'escalate',
    reason: 'the secret expired',
  })
})
