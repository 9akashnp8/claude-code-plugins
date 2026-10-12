import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  addArtifact,
  cappedSummary,
  currentSprint,
  dayBefore,
  earlierDaysIn,
  emptyIssue,
  EMPTY_ACTIVITY,
  isIssueReady,
  isReviewTool,
  newIssuePrompt,
  parseNewIssue,
  parseSuggestion,
  parseUpdate,
  progressOf,
  publishedArtifactOf,
  relativeTo,
  reviewRequestOf,
  sprintOf,
  sprintValue,
  toDocument,
  toIssueDocument,
  toSprints,
  UPDATE_RULES,
} from '../hooks/format'

const CONFIG = { site: 'https://team.atlassian.net', email: 'me@example.com', tokenBlob: 'sealed' }
const MOVES = [
  { id: '21', name: 'Start work', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
  { id: '31', name: 'Send to review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
]

// One scrum board whose sprint 41 has ended, 42 is under way and 43 is next.
const SPRINTS = [
  { id: 41, name: 'CPC Sprint 11', state: 'closed' },
  { id: 42, name: 'CPC Sprint 12', state: 'active' },
  { id: 43, name: 'CPC Sprint 13', state: 'future' },
]

// Stands in for Jira, PowerShell and the session beneath the plugin; answers with what was sent.
// Without `hasSprints` the site has no Jira Software, so its board API answers 404.
function fakeJira(on: On, entries: Record<string, unknown> = {}, hasSprints = true) {
  const sent: string[] = []
  const toasts: string[] = []
  const created: { fields: Record<string, unknown> }[] = []
  const sprinted: { sprint: string; issues: string[] }[] = []
  let status = { name: 'To Do', statusCategory: { key: 'new' } }
  mock.store(on, { config: CONFIG, ...entries })
  const clock = mock.clock(on, { now: new Date(2026, 9, 6, 9, 30).getTime() })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'token\n', stderr: '' } }))
  on('session.root', () => ({ value: 'C:\\code\\repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  // What the plugins beneath draw in the band, such as git-push's line.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ key: 'beneath' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace(CONFIG.site, '')
    sent.push(`${method} ${path}`)
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    const empty = { value: { status: 204, ok: true, headers: {}, text: '' } }
    if (path.startsWith('/rest/agile/') && !hasSprints) {
      return { value: { status: 404, ok: false, headers: {}, text: '{"errorMessages": ["Not found"]}' } }
    }
    if (path.startsWith('/rest/agile/1.0/board?')) return json({ values: [{ id: 7, type: 'scrum' }] })
    if (path.startsWith('/rest/agile/1.0/board/7/sprint')) return json({ values: SPRINTS })
    const sprint = path.match(/^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/)?.[1]
    if (sprint !== undefined) {
      sprinted.push({ sprint, issues: (JSON.parse(e.init?.body ?? '{}') as { issues: string[] }).issues })
      return empty
    }
    if (path.endsWith('/transitions') && method === 'GET') return json({ transitions: MOVES })
    if (path.endsWith('/transitions')) {
      const { transition } = JSON.parse(e.init?.body ?? '{}') as { transition: { id: string } }
      status = MOVES.find(one => one.id === transition.id)?.to ?? status
      return empty
    }
    if (path.includes('/createmeta/')) {
      return json({ issueTypes: [{ name: 'Story', subtask: false }, { name: 'Task', subtask: false }, { name: 'Sub-task', subtask: true }] })
    }
    if (path === '/rest/api/3/myself') return json({ accountId: 'me-1', displayName: 'Me' })
    if (path.endsWith('/assignee')) return empty
    if (path.endsWith('/comment') && method === 'POST') return json({ id: '100', updated: '2026-10-06T09:30:00.000+0000' })
    if (path === '/rest/api/3/issue' && method === 'POST') {
      created.push(JSON.parse(e.init?.body ?? '{}'))
      return json({ key: 'CPC-2' })
    }
    const key = path.match(/\/issue\/([A-Z]+-\d+)/)?.[1] ?? 'CPC-1'
    return json({ key, fields: { summary: 'Build the thing', status } })
  })

  return { sent, toasts, created, sprinted, clock }
}

const BAND = {
  plugin: 'jira-log',
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

test('the band offers setup until the worktree is linked or skipped', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /not set up/ }))?.text).toBe('Jira log is not set up')
    expect((await ui.find({ key: 'link' }))?.props.label).toBe('Set up')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'skip' })
  expect(await ui.find({ key: 'link' })).toBeUndefined()
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('the setup button saves what was typed without Enter', async ($, on) => {
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'jira-log',
      surface,
      component: 'Pane',
      requestId: 'jira',
      props: { title: 'Jira', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } },
    })
    await ui.input({ key: 'site', text: 'team.atlassian.net', kind: 'change' })
    await ui.input({ key: 'email', text: 'me@example.com', kind: 'change' })
    await ui.press({ key: 'test' })

    // The https:// prefix is added on save, so seeing it means the value went through the store.
    expect((await ui.find({ key: 'site' }))?.props.value).toBe('https://team.atlassian.net')
    expect((await ui.find({ key: 'email' }))?.props.value).toBe('me@example.com')
    expect((await ui.find({ type: 'Text', text: /missing/ }))?.text).toBe(
      'Jira is not set up yet, missing API token: run /jira setup.',
    )
    await ui.unmount()
  }
})

test('linking a To Do issue moves it to In Progress', async ($, on) => {
  const { sent, toasts } = fakeJira(on)

  const { text } = await $.command.run({ command: 'jira', args: 'link cpc-1' })

  expect(text).toBe('Linked this worktree to CPC-1: Build the thing [To Do].')
  expect(sent).toContain('POST /rest/api/3/issue/CPC-1/transitions')
  expect(toasts).toContain('Moved CPC-1 to In Progress (work started)')
})

test('a pull request is a clue for the update, and the issue moves only when the person confirms', async ($, on) => {
  const linked = { key: 'CPC-1', summary: 'Build the thing', status: 'In Progress', statusCategory: 'indeterminate' }
  const { sent, toasts, clock } = fakeJira(on, { links: { 'C:\\code\\repo': linked } })
  const prompts: string[] = []
  const url = 'https://devops.example.com/tfs/Apps/_git/repo/pullrequest/42'
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: `{"url": "${url}"}`, stderr: '', interrupted: false },
    text: `{"url": "${url}"}`,
  }))
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '{"notes": ["Opened the pull request"], ' +
          '"move": {"to": "in review", "reason": "A pull request was opened."}}',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  await $.session.start({ cwd: 'C:\\code\\repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Bash', command: 'az repos pr create --title "Export"' })
  await clock.settle()
  await $.command.run({ command: 'jira', args: 'update' })
  const pane = await $.ui.mount({
    plugin: 'jira-log',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jira',
    props: { title: 'Jira', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } },
  })

  expect(prompts[0]).toContain(url)
  expect(prompts[0]).toContain(UPDATE_RULES)
  expect(sent.some(line => line.startsWith('POST'))).toBe(false)
  expect((await pane.find({ key: 'accept-move' }))?.props.label).toBe('Move to In Review')

  await pane.press({ key: 'accept-move' })
  await pane.unmount()

  expect(sent.filter(line => line.startsWith('POST'))).toEqual(['POST /rest/api/3/issue/CPC-1/transitions'])
  expect(toasts).toContain('Moved CPC-1 to In Review')
})

test('the band shows whether today’s work on the linked issue is in Jira', async ($, on) => {
  const linked = { key: 'CPC-1', summary: 'Build the thing', status: 'In Progress', statusCategory: 'indeterminate' }
  const { clock } = fakeJira(on, { links: { 'C:\\code\\repo': linked } })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: 'C:\\code\\repo\\src\\a.ts' }, text: 'edited' }))
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: '{"notes": ["Built the thing"], "move": {"to": ""}}',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  await $.session.start({ cwd: 'C:\\code\\repo', surface: 'terminal', isInteractive: true })
  const edit = async () => {
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\code\\repo\\src\\a.ts', old_string: 'a', new_string: 'b' })
    await clock.settle()
  }
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const progressText = () => band.find({ type: 'Text', text: /today|posted/ })
  const line = async () => (await progressText())?.text

  expect((await band.find({ type: 'Text', text: /CPC-1/ }))?.text).toBe('CPC-1 · In Progress ·')
  expect(await band.find({ key: 'beneath' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  expect(await line()).toBe('nothing recorded today')
  expect(await band.find({ key: 'draft-update' })).toBeUndefined()

  await edit()
  expect(await line()).toBe('1 action today, not in Jira yet')
  expect((await progressText())?.props.color).toBe('warning')
  expect((await band.find({ key: 'draft-update' }))?.props.label).toBe('Draft update')

  await band.press({ key: 'draft-update' })
  const pane = await $.ui.mount({
    plugin: 'jira-log',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jira',
    props: { title: 'Jira', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } },
  })
  await pane.press({ key: 'post' })
  await pane.unmount()
  expect(await line()).toBe("✓ today's update posted 09:30")
  expect((await progressText())?.props.color).toBe('success')

  await edit()
  expect(await line()).toBe('posted 09:30, 1 action since')
  expect((await band.find({ key: 'draft-update' }))?.props.label).toBe('Update')
  await band.unmount()
})

test('yesterday’s progress does not count as today’s', async () => {
  const yesterday = { day: '2026-10-05', actions: 4, postedActions: 4, postedAt: 1 }

  expect(progressOf(yesterday, '2026-10-06').text).toBe('nothing recorded today')
  expect(progressOf(null, '2026-10-06').short).toBe('')
})

test('pull and merge requests are recognised whatever opened them', async () => {
  const github = 'https://github.com/me/repo/pull/7'

  expect(reviewRequestOf('gh pr create --fill', `Creating...\n${github}\n`)).toBe(github)
  expect(reviewRequestOf('glab mr create -f', 'no url printed')).toBe('glab mr create')
  expect(reviewRequestOf('git push origin HEAD', github)).toBeUndefined()
  expect(isReviewTool('mcp__github__create_pull_request')).toBe(true)
  expect(isReviewTool('mcp__azure-devops__repo_create_pull_request')).toBe(true)
  expect(isReviewTool('mcp__gitlab__create_merge_request')).toBe(true)
  expect(isReviewTool('mcp__github__list_pull_requests')).toBe(false)
})

test('a suggested move must be one the workflow allows from here', async () => {
  const moves = [{ id: '31', name: 'Review', to: 'In Review' }]
  const reply = (to: string) => `{"move": {"to": "${to}", "reason": "PR opened."}}`

  expect(parseSuggestion(reply('In Review'), moves, 'In Progress')).toEqual({ id: '31', to: 'In Review', reason: 'PR opened.' })
  expect(parseSuggestion(reply('Done'), moves, 'In Progress')).toBeNull()
  expect(parseSuggestion(reply(''), moves, 'In Progress')).toBeNull()
  expect(parseSuggestion('{"notes": []}', moves, 'In Progress')).toBeNull()
})

const CREATE_PANE = {
  plugin: 'jira-log',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'jira',
  props: { title: 'Jira', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } },
} as const

const drafting = (prompts: string[], text: string) => ($: unknown, e: { prompt: string }) => {
  prompts.push(e.prompt)
  return {
    value: {
      isAnswered: true as const,
      text,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
}

test('a drafted issue is created in the current sprint, assigned, linked and started', async ($, on) => {
  const { sent, toasts, created, sprinted } = fakeJira(on, { config: { ...CONFIG, project: 'CPC' } })
  const prompts: string[] = []
  on('model.fork', drafting(prompts, '{"summary": "Add CSV export", "description": "Let people export the report."}'))

  await $.command.run({ command: 'jira', args: 'new  a ticket for the CSV export' })
  const pane = await $.ui.mount(CREATE_PANE)
  expect((await pane.find({ key: 'type' }))?.props.value).toBe('Task')
  expect((await pane.find({ key: 'sprint' }))?.props.value).toBe('42')
  expect((await pane.find({ key: 'sprint' }))?.props.options).toEqual([
    { value: '42', label: 'CPC Sprint 12 (current)' },
    { value: '43', label: 'CPC Sprint 13' },
    { value: 'backlog', label: 'Backlog' },
  ])
  await pane.press({ key: 'create' })
  await pane.unmount()

  expect(prompts[0]).toContain('The person asked for: "a ticket for the CSV export".')
  expect(created[0]?.fields).toEqual({
    project: { key: 'CPC' },
    summary: 'Add CSV export',
    issuetype: { name: 'Task' },
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Let people export the report.' }] }],
    },
  })
  expect(sprinted).toEqual([{ sprint: '42', issues: ['CPC-2'] }])
  expect(sent).toContain('PUT /rest/api/3/issue/CPC-2/assignee')
  expect(sent).toContain('POST /rest/api/3/issue/CPC-2/transitions')
  expect(toasts).toContain('Linked this worktree to CPC-2')
})

test('a ticket written by hand is created without asking the model, in the sprint picked', async ($, on) => {
  const { sent, toasts, created, sprinted } = fakeJira(on, { config: { ...CONFIG, project: 'CPC' } })
  let asked = 0
  on('model.fork', () => {
    asked += 1
    return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  on('model.complete', () => {
    asked += 1
    return { value: { isAnswered: false, reason: 'unavailable' } }
  })

  await $.command.run({ command: 'jira', args: 'new --manual' })
  const pane = await $.ui.mount(CREATE_PANE)
  // Nothing can be created, or revised by the model, until there is a title.
  expect(await pane.find({ key: 'create' })).toBeUndefined()
  expect(await pane.find({ key: 'revise-issue' })).toBeUndefined()
  expect((await pane.find({ key: 'type' }))?.props.value).toBe('Task')

  await pane.input({ key: 'summary', text: '  Add CSV export  ', kind: 'change' })
  await pane.input({ key: 'description', text: 'Let people export the report.', kind: 'change' })
  await pane.select({ key: 'sprint', value: '43' })
  expect(await pane.find({ key: 'revise-issue' })).toBeDefined()
  await pane.press({ key: 'create' })
  await pane.unmount()

  expect(asked).toBe(0)
  expect(created[0]?.fields).toEqual({
    project: { key: 'CPC' },
    summary: 'Add CSV export',
    issuetype: { name: 'Task' },
    description: toIssueDocument({ ...emptyIssue('Task'), description: 'Let people export the report.' }),
  })
  expect(sprinted).toEqual([{ sprint: '43', issues: ['CPC-2'] }])
  expect(sent).toContain('PUT /rest/api/3/issue/CPC-2/assignee')
  expect(toasts).toContain('Linked this worktree to CPC-2')
})

test('a drafted ticket can be edited in the form and left in the backlog', async ($, on) => {
  const { created, sent, sprinted } = fakeJira(on, { config: { ...CONFIG, project: 'CPC' } })
  on('model.fork', drafting([], '{"summary": "Add CSV export", "description": "Write the export."}'))

  await $.command.run({ command: 'jira', args: 'new' })
  const pane = await $.ui.mount(CREATE_PANE)
  expect((await pane.find({ key: 'summary' }))?.props.value).toBe('Add CSV export')
  expect((await pane.find({ key: 'description' }))?.props.value).toBe('Write the export.')
  await pane.input({ key: 'summary', text: 'Export the report as CSV', kind: 'change' })
  await pane.input({ key: 'description', text: '', kind: 'change' })
  await pane.select({ key: 'sprint', value: 'backlog' })
  await pane.press({ key: 'create' })
  await pane.unmount()

  expect(created[0]?.fields.summary).toBe('Export the report as CSV')
  expect(created[0]?.fields.description).toEqual(toIssueDocument(emptyIssue('Task')))
  expect(sprinted).toEqual([])
  expect(sent).toContain('PUT /rest/api/3/issue/CPC-2/assignee')
})

test('without Jira Software there is no sprint to pick and the issue goes to the backlog', async ($, on) => {
  const { created, sprinted } = fakeJira(on, { config: { ...CONFIG, project: 'CPC' } }, false)

  await $.command.run({ command: 'jira', args: 'new --manual' })
  const pane = await $.ui.mount(CREATE_PANE)
  expect(await pane.find({ key: 'sprint' })).toBeUndefined()
  await pane.input({ key: 'summary', text: 'Add CSV export', kind: 'change' })
  await pane.press({ key: 'create' })
  await pane.unmount()

  expect(created[0]?.fields.summary).toBe('Add CSV export')
  expect(sprinted).toEqual([])
})

test('a revision rewrites the title and description and keeps the type and sprint', async ($, on) => {
  fakeJira(on, { config: { ...CONFIG, project: 'CPC' } })
  const prompts: string[] = []
  on('model.fork', drafting(prompts, '{"summary": "Fix the login page", "description": "Stop the login loop."}'))

  await $.command.run({ command: 'jira', args: 'new --manual' })
  const pane = await $.ui.mount(CREATE_PANE)
  await pane.input({ key: 'summary', text: 'Add CSV export', kind: 'change' })
  await pane.select({ key: 'type', value: 'Story' })
  await pane.select({ key: 'sprint', value: '43' })
  await pane.input({ key: 'revise-issue', text: 'make it about the login page' })

  expect(prompts[0]).toContain('{"summary":"Add CSV export","description":""}')
  expect((await pane.find({ key: 'summary' }))?.props.value).toBe('Fix the login page')
  expect((await pane.find({ key: 'description' }))?.props.value).toBe('Stop the login loop.')
  expect((await pane.find({ key: 'type' }))?.props.value).toBe('Story')
  expect((await pane.find({ key: 'sprint' }))?.props.value).toBe('43')
  await pane.unmount()
})

test('the band offers a blank ticket beside the drafted one once Jira is set up', async ($, on) => {
  fakeJira(on, { config: { ...CONFIG, project: 'CPC' } })
  await $.session.start({ cwd: 'C:\\code\\repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'new' }))?.props.label).toBe('Create new')
  expect((await ui.find({ key: 'manual' }))?.props.label).toBe('Write it myself')
  await ui.unmount()
})

test('a ticket needs only a title, capped at Jira’s limit', async () => {
  expect(isIssueReady(emptyIssue('Task'))).toBe(false)
  expect(isIssueReady({ ...emptyIssue('Task'), summary: '  ' })).toBe(false)
  expect(isIssueReady({ ...emptyIssue('Task'), summary: 'Add CSV export' })).toBe(true)
  expect(cappedSummary('x'.repeat(300))).toHaveLength(255)
  expect(parseNewIssue(`{"summary": "${'x'.repeat(300)}"}`)).toEqual({ summary: 'x'.repeat(255), description: '' })
  expect(() => parseNewIssue('{"summary": " ", "description": "Something"}')).toThrow('the model drafted no summary')
})

test('without a focus the ticket covers the main work of the conversation', async () => {
  expect(newIssuePrompt('')).toContain('Base it on the main piece of work in this conversation.')
  expect(newIssuePrompt('')).not.toContain('The person asked for')
})

test('a ticket’s description is a paragraph per line, with no headings', async () => {
  const issue = { ...emptyIssue('Task'), description: 'Let people export the report.\r\n\r\n  Done when it downloads. ' }

  expect(toIssueDocument(issue).content).toEqual([
    { type: 'paragraph', content: [{ type: 'text', text: 'Let people export the report.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Done when it downloads.' }] },
  ])
  expect(toIssueDocument(emptyIssue('Task')).content).toEqual([])
})

test('the current sprint comes first, then the future ones, each once; closed ones are left out', async () => {
  const sprints = toSprints([
    [
      { id: 43, name: 'Sprint 13', state: 'future' },
      { id: 41, name: 'Sprint 11', state: 'closed' },
    ],
    [
      { id: 42, name: 'Sprint 12', state: 'active' },
      { id: 43, name: 'Sprint 13', state: 'future' },
    ],
  ])

  expect(sprints).toEqual([
    { id: 42, name: 'Sprint 12', state: 'active' },
    { id: 43, name: 'Sprint 13', state: 'future' },
  ])
  expect(currentSprint(sprints)).toBe(42)
  expect(currentSprint(sprints.slice(1))).toBeNull()
  expect(sprintOf(sprintValue(null))).toBeNull()
  expect(sprintOf(sprintValue(43))).toBe(43)
})

test('a fenced model reply parses into its notes, dropping anything that is not one', async () => {
  const reply = '```json\n{"notes": ["Shipped the parser", 1, " ", "Docs wait on review"], "completed": ["x"]}\n```'

  expect(parseUpdate(reply)).toEqual({ notes: ['Shipped the parser', 'Docs wait on review'] })
})

test('the comment is the dated line and the notes as one list, with no section headings', async () => {
  const document = toDocument('2026-10-05', { notes: ['Shipped the parser', 'Docs wait on review'] })

  expect(document.content.map(block => block.type)).toEqual(['paragraph', 'bulletList'])
  expect(toDocument('2026-10-05', { notes: [] }).content.length).toBe(1)
})

test('edited paths are recorded relative to the worktree', async () => {
  expect(relativeTo('C:\\code\\repo', 'c:\\code\\repo\\src\\a.ts')).toBe('src/a.ts')
  expect(relativeTo('C:\\code\\repo', 'D:\\elsewhere\\b.ts')).toBe('D:/elsewhere/b.ts')
})

const PANE_PROPS = {
  plugin: 'jira-log',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'jira',
  props: {
    title: 'Jira',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const answered = (prompts: string[]) => ($: unknown, e: { prompt: string }) => {
  prompts.push(e.prompt)
  return {
    value: {
      isAnswered: true as const,
      text: '{"notes": ["Redesigned the home page"], "move": {"to": ""}}',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
}

test('work from an earlier day that never reached Jira goes into today’s update', async ($, on) => {
  const linked = { key: 'CPC-1', summary: 'Build the thing', status: 'In Progress', statusCategory: 'indeterminate' }
  const yesterday = {
    ...EMPTY_ACTIVITY,
    artifacts: [{ url: 'https://claude.ai/artifact/abc', title: 'Home Page Redesign' }],
    actions: 3,
  }
  fakeJira(on, { links: { 'C:\\code\\repo': linked }, 'activity:CPC-1:2026-10-05': yesterday })
  const prompts: string[] = []
  on('model.fork', answered(prompts))
  await $.session.start({ cwd: 'C:\\code\\repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = async () => (await band.find({ type: 'Text', text: /today|earlier|posted/ }))?.text

  expect(await line()).toBe('3 actions from earlier days, not in Jira yet')

  await band.press({ key: 'draft-update' })
  const pane = await $.ui.mount(PANE_PROPS)
  await pane.press({ key: 'post' })
  await pane.unmount()

  expect(prompts[0]).toContain('It also covers 2026-10-05, whose work never reached Jira.')
  expect(prompts[0]).toContain('Home Page Redesign')
  expect(await line()).toBe("✓ today's update posted 09:30")
  await band.unmount()
})

test('an earlier day posted in full, or older than the lookback, is not offered again', async ($, on) => {
  const linked = { key: 'CPC-1', summary: 'Build the thing', status: 'In Progress', statusCategory: 'indeterminate' }
  const day = { ...EMPTY_ACTIVITY, actions: 2 }
  fakeJira(on, {
    links: { 'C:\\code\\repo': linked },
    'activity:CPC-1:2026-10-05': day,
    'comment:CPC-1:2026-10-05': { id: '9', updated: 'x', update: { notes: [] }, actions: 2 },
    'activity:CPC-1:2026-10-04': day,
    'covered:CPC-1:2026-10-04': { actions: 2, in: '2026-10-05' },
    'activity:CPC-1:2026-09-01': day,
  })
  await $.session.start({ cwd: 'C:\\code\\repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await band.find({ type: 'Text', text: /today|earlier/ }))?.text).toBe('nothing recorded today')
  await band.unmount()
})

test('a published Artifact is recorded for the update, and reading one is not', async ($, on) => {
  const linked = { key: 'CPC-1', summary: 'Build the thing', status: 'In Progress', statusCategory: 'indeterminate' }
  const { clock } = fakeJira(on, { links: { 'C:\\code\\repo': linked } })
  const url = 'https://claude.ai/artifact/abc'
  const prompts: string[] = []
  on('model.fork', answered(prompts))
  on('tool.call', { tool: 'Artifact' }, () => ({
    result: { url, path: 'project/canvas.json', title: 'Home Page Redesign' },
    text: `Updated the Artifact at ${url}`,
  }))
  await $.session.start({ cwd: 'C:\\code\\repo', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Artifact', url, file_path: 'C:\\scratch\\project\\canvas.json' })
  await $.tool.call({ tool: 'Artifact', action: 'read', url })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /today/ }))?.text).toBe('1 action today, not in Jira yet')
  await band.unmount()
  await $.command.run({ command: 'jira', args: 'update' })

  expect(prompts[0]).toContain(url)
  expect(prompts[0]).toContain('Home Page Redesign')
})

test('the band counts earlier unposted work alongside today’s', async () => {
  const at = (actions: number, earlier: number, postedAt: number | null = null) => ({
    day: '2026-10-06',
    actions,
    postedActions: postedAt === null ? 0 : actions,
    postedAt,
    earlier,
  })

  expect(progressOf(at(2, 3), '2026-10-06')).toEqual({
    tone: 'due',
    text: '2 actions today and 3 earlier, not in Jira yet',
    short: '5 unposted',
  })
  expect(progressOf(at(2, 0), '2026-10-06').text).toBe('2 actions today, not in Jira yet')
  expect(progressOf(at(2, 1, new Date(2026, 9, 6, 9, 30).getTime()), '2026-10-06').text).toBe(
    'posted 09:30, 1 action not in Jira yet',
  )
})

test('earlier days are the issue’s own, within the lookback, oldest first', async () => {
  const keys = [
    'activity:CPC-1:2026-10-05',
    'activity:CPC-1:2026-09-20',
    'activity:CPC-1:2026-10-06',
    'activity:CPC-10:2026-10-04',
    'comment:CPC-1:2026-10-04',
    'activity:CPC-1:2026-09-30',
  ]

  expect(earlierDaysIn(keys, 'CPC-1', '2026-10-06')).toEqual(['2026-09-30', '2026-10-05'])
  expect(dayBefore('2026-03-01', 1)).toBe('2026-02-28')
})

test('only a publish names an Artifact, with its title from the call or the answer', async () => {
  const url = 'https://claude.ai/artifact/EQPnCG'

  expect(publishedArtifactOf({ title: 'Home Page Redesign' }, undefined, `Created a new Artifact at ${url} (v1)`)).toEqual(
    { url, title: 'Home Page Redesign' },
  )
  expect(publishedArtifactOf({ url }, { url, path: 'project/Main.dc.html', title: 'Home' }, '')).toEqual({
    url,
    title: 'Home',
  })
  expect(publishedArtifactOf({ action: 'read', url }, { url }, '')).toBeUndefined()
  expect(publishedArtifactOf({ url, asset: true }, { url }, '')).toBeUndefined()

  const named = addArtifact(addArtifact([], { url, title: '' }), { url, title: 'Home' })
  expect(named).toEqual([{ url, title: 'Home' }])
  expect(addArtifact(named, { url, title: '' })).toBe(named)
})
