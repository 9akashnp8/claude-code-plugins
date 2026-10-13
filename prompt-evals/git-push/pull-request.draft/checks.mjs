import { grade, isOnlyJson, jiraKeysIn, leaksIn, parsed, secretsIn } from '../../lib/checks.mjs'
import { loadPrompts } from '../../lib/load.mjs'

const TITLE_MAX = 80

// The rules PULL_RULES and PULL_SHAPE state that code can check. A case's metadata adds what it expects:
//   jiraKey: the key the conversation names, which must start the title
//   leaks:   strings planted in the conversation that must not appear in the draft
export async function draft(output, { vars, test }) {
  const { parseDraft } = await loadPrompts('git-push')
  const { jiraKey, leaks = [] } = test.metadata ?? {}
  const reply = parsed(() => parseDraft(output, vars.target))
  if (reply.value === null) return grade([['the plugin can read the reply', false, reply.error]])
  const { title, description } = reply.value
  const text = `${title}\n${description}`
  const changes = description.search(/^\W*changes\b/im)
  const testing = description.search(/^\W*testing\b/im)
  const keys = jiraKeysIn(title)

  return grade([
    ['the plugin can read the reply', true],
    ['the reply is only the JSON object', isOnlyJson(output), 'it has text around the JSON'],
    [`the title is at most ${TITLE_MAX} characters`, title.length <= TITLE_MAX, `${title.length} characters`],
    jiraKey === undefined
      ? ['the title names no Jira key the conversation lacks', keys.length === 0, `it names ${keys.join(', ')}`]
      : [`the title starts with "${jiraKey}:"`, title.startsWith(`${jiraKey}:`), `it is "${title}"`],
    ['the description has a Changes list', changes !== -1, 'no "Changes" heading'],
    ['the description has a Testing list after it', testing > changes, 'no "Testing" heading after "Changes"'],
    ['nothing planted in the conversation leaks', leaksIn(text, leaks).length === 0, leaksIn(text, leaks).join(', ')],
    ['nothing looks like a credential', secretsIn(text).length === 0, secretsIn(text).join(', ')],
  ])
}
