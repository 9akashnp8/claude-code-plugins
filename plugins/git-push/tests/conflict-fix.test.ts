import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PULL_POLL_MS } from '../hooks/ado'
import { activePull, ADO_REMOTE, BAND, fakeGit, SESSION } from './fake'
import type { Repo } from './fake'

const PUSHED = { upstream: 'origin/feature/export', ahead: 0, remote: ADO_REMOTE, credential: 'username=me\npassword=pat\n' }
const FILES = ['src/export.ts', 'src/routes.ts']

const complete = (turnId: string, answer: string) =>
  ({ answer, durationMs: 1000, isAborted: false, turnId, reason: 'answer' }) as const

async function conflicted($: Engine, on: On, start: Partial<Repo> = {}) {
  const pull = activePull({ mergeStatus: 'conflicts' })
  const fake = fakeGit(on, { ...PUSHED, conflicts: FILES, ...start }, { server: { pulls: [pull] } })
  await $.session.start({ ...SESSION, surface: 'terminal' })
  await fake.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  return { ...fake, pull, band }
}

test('conflicts are merged in here, handed to Claude file by file, and the merge is pushed', async ($, on) => {
  const { repo, pull, ran, submitted, toasts, clock, band } = await conflicted($, on)

  expect((await band.find({ type: 'Text', text: /conflicts/ }))?.text).toBe('Active · has conflicts')
  await band.press({ key: 'fix-conflicts' })
  await clock.settle()

  expect(ran).toContain('git fetch --prune origin')
  expect(ran).toContain('git merge --no-edit origin/main')
  const prompt = submitted[0] ?? ''
  expect(prompt.startsWith('Pull request #7 has merge conflicts.')).toBe(true)
  expect(prompt).toContain('merged "origin/main" into "feature/export"')
  expect(prompt).toContain('- src/export.ts\n- src/routes.ts')
  expect(prompt).toContain('git commit --no-edit')
  expect((await band.find({ type: 'Text', text: /resolving/ }))?.text).toBe('Claude is resolving the conflicts…')

  await $.turn.start({ text: prompt, turnId: 'merge-1' })
  repo.isMerging = false
  repo.ahead = 3
  await $.turn.complete(complete('merge-1', 'Kept both the new route and the export changes. Merge committed.'))
  await clock.settle()

  expect(ran).toContain('git push --set-upstream origin HEAD')
  expect(toasts).toContain('Pushed feature/export to origin')
  // Until Azure DevOps tries the merge again, it still reports the conflicts it found; they are not offered again.
  expect(await band.find({ key: 'fix-conflicts' })).toBeUndefined()

  Object.assign(pull, { mergeStatus: 'succeeded', lastMergeSourceCommit: { commitId: 'source-2' } })
  await clock.advance(PULL_POLL_MS)
  expect(await band.find({ type: 'Text', text: /conflicts/ })).toBeUndefined()

  // The target moves on and conflicts again: a new merge, offered again.
  Object.assign(pull, { mergeStatus: 'conflicts', lastMergeTargetCommit: { commitId: 'target-2' } })
  await clock.advance(PULL_POLL_MS)
  expect(await band.find({ key: 'fix-conflicts' })).toBeDefined()
  await band.unmount()
})

test('uncommitted changes stop the merge before it starts', async ($, on) => {
  const { ran, submitted, toasts, clock, band } = await conflicted($, on, { changes: [' M src/export.ts'] })
  await band.press({ key: 'fix-conflicts' })
  await clock.settle()

  expect(ran.some(command => command.startsWith('git merge'))).toBe(false)
  expect(submitted).toEqual([])
  expect(toasts).toContain('Could not fix the conflicts: commit or stash your changes first, so the merge holds nothing else')
  expect(await band.find({ key: 'fix-conflicts' })).toBeDefined()
  await band.unmount()
})

test('a merge git makes alone is pushed with no turn for Claude', async ($, on) => {
  const { ran, submitted, toasts, clock, band } = await conflicted($, on, { conflicts: [] })
  await band.press({ key: 'fix-conflicts' })
  await clock.settle()

  expect(submitted).toEqual([])
  expect(toasts).toContain('Merged origin/main with no conflicts here; pushing it')
  expect(ran).toContain('git push --set-upstream origin HEAD')
  expect(await band.find({ type: 'Text', text: /Merging|Pushing the merge/ })).toBeUndefined()
  expect(await band.find({ key: 'fix-conflicts' })).toBeUndefined()
  await band.unmount()
})

test('a merge Claude leaves unfinished is picked up where it stopped', async ($, on) => {
  const { repo, ran, submitted, toasts, clock, band } = await conflicted($, on)
  await band.press({ key: 'fix-conflicts' })
  await clock.settle()
  await $.turn.start({ text: submitted[0] ?? '', turnId: 'merge-1' })
  repo.conflicts = ['src/routes.ts']
  await $.turn.complete(complete('merge-1', 'Resolved src/export.ts.'))
  await clock.settle()

  expect(toasts).toContain('Claude left the merge unfinished: Fix conflicts picks it up where it stopped')
  expect(ran.some(command => command.startsWith('git push'))).toBe(false)

  await band.press({ key: 'fix-conflicts' })
  await clock.settle()

  expect(ran.filter(command => command.startsWith('git merge'))).toHaveLength(1)
  expect(submitted[1]).toContain('These files are in conflict:\n- src/routes.ts\n\n')
  await band.unmount()
})

test('a conflict only a person can decide is shown and notified, with the merge left in progress', async ($, on) => {
  const { repo, pull, ran, submitted, notified, clock, band } = await conflicted($, on)
  await band.press({ key: 'fix-conflicts' })
  await clock.settle()
  await $.turn.start({ text: submitted[0] ?? '', turnId: 'merge-1' })
  await $.turn.complete(
    complete('merge-1', 'main removed the CSV route this branch extends.\nESCALATE: decide whether CSV export stays'),
  )
  await clock.settle()

  expect((await band.find({ type: 'Text', text: /Needs you/ }))?.text).toBe('Needs you: decide whether CSV export stays')
  expect(notified).toEqual(['PR #7: decide whether CSV export stays'])
  expect(repo.isMerging).toBe(true)
  expect(ran.some(command => command.startsWith('git push'))).toBe(false)
  expect(await band.find({ key: 'fix-conflicts' })).toBeUndefined()

  Object.assign(pull, { mergeStatus: 'succeeded', lastMergeSourceCommit: { commitId: 'source-2' } })
  await clock.advance(PULL_POLL_MS)
  expect(await band.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
  await band.unmount()
})
