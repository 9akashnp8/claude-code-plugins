import type { PullRequestDraft } from '../types'

// Every prompt this plugin sends, each beside the parser for its reply. Pure and with type-only imports, so
// prompt-evals/ can run them against fixtures outside Claude Code.

// Azure DevOps refuses a longer description.
const DESCRIPTION_LIMIT = 4000
const TITLE_LIMIT = 400

// How much of the log and the diffstat goes in; a long branch would otherwise crowd out the conversation.
const COMMITS_LIMIT = 8000
const DIFFSTAT_LIMIT = 4000

export const PULL_RULES = [
  'Rules:',
  '- title: one line of at most 80 characters saying what the change does, in the imperative. When this ' +
    'conversation names a Jira issue key (such as CPC-123) for the work, start the title with it and a colon.',
  '- description: Markdown a reviewer reads first. One short paragraph on why the change is needed, then a ' +
    '"Changes" list of what changed, then a "Testing" list of how it was checked. Only list testing this ' +
    'conversation shows was done; when none was, say so.',
  '- Plain words. No secrets, credentials or internal hostnames. Never invent anything.',
].join('\n')

export const PULL_SHAPE = 'Answer with only this JSON object and nothing else:\n{"title": "", "description": ""}'

export type DraftInput = {
  branch: string
  target: string
  // `git log --no-merges --format=- %s%n%w(0,2,2)%b origin/<target>..HEAD`
  commits: string
  // `git diff --stat origin/<target>...HEAD`
  diffstat: string
}

export const draftPrompt = ({ branch, target, commits, diffstat }: DraftInput) =>
  [
    `Draft an Azure DevOps pull request merging branch "${branch}" into "${target}".`,
    `These commits and files are everything it changes, compared with "${target}".`,
    `Its commits:\n${commits.slice(0, COMMITS_LIMIT).trim() || '(none listed)'}`,
    `Files changed:\n${diffstat.slice(0, DIFFSTAT_LIMIT).trim() || '(none listed)'}`,
    'Take what changed from those alone: the "Changes" list names nothing they do not show, even when this ' +
      'conversation discusses other work. Use the conversation for why the change is needed and how it was tested.',
    PULL_RULES,
    PULL_SHAPE,
  ].join('\n\n')

export type ReviseInput = { current: Pick<PullRequestDraft, 'title' | 'description'>; instruction: string }

export const revisePrompt = ({ current, instruction }: ReviseInput) =>
  [
    `This is the current draft of the pull request:\n${JSON.stringify({ title: current.title, description: current.description })}`,
    `Revise it as follows: ${instruction.trim()}`,
    PULL_RULES,
    PULL_SHAPE,
  ].join('\n\n')

export function parseDraft(reply: string, target: string): PullRequestDraft {
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
  let found: { title?: unknown; description?: unknown } = {}
  try {
    found = JSON.parse(json) as typeof found
  } catch {
    throw new Error('the model did not answer with a draft')
  }
  const title = typeof found.title === 'string' ? found.title.trim().split('\n')[0] ?? '' : ''
  if (title === '') throw new Error('the model drafted no title')
  const description = typeof found.description === 'string' ? found.description.trim() : ''

  return { title: title.slice(0, TITLE_LIMIT), description: description.slice(0, DESCRIPTION_LIMIT), target }
}
