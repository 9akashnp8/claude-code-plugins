import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The one place that imitates $.model.fork: the session's conversation, then the plugin's prompt as the next
// user turn. A real fork also carries Claude Code's system prompt, CLAUDE.md and the tool definitions, which
// no fixture reproduces, so a prompt that passes here still gets one try in a real session.

const CONVERSATIONS = fileURLToPath(new URL('../conversations/', import.meta.url))

// A conversation is the name of a file in conversations/ or the turns themselves, in the shape the mods
// API's session.messages() answers with: [{ role, text, toolUses? }]. An empty one is the model.complete
// path, taken when there is nothing to fork yet.
export function turnsOf(conversation) {
  if (conversation === undefined || conversation === null || conversation === '') return []
  if (Array.isArray(conversation)) return conversation

  return JSON.parse(readFileSync(`${CONVERSATIONS}${conversation}.json`, 'utf8')).turns
}

const toolLine = ({ name, input, result }) =>
  [`[${name}] ${input ?? ''}`.trim(), result ? `  → ${result}` : ''].filter(Boolean).join('\n')

const textOf = ({ text = '', toolUses = [] }) => [text.trim(), ...toolUses.map(toolLine)].filter(Boolean).join('\n\n')

// The API takes alternating turns that start with the user, so turns of one role in a row are joined.
export function forkMessages(conversation, prompt) {
  const messages = []
  for (const { role, content } of [
    ...turnsOf(conversation).map(turn => ({ role: turn.role, content: textOf(turn) })),
    { role: 'user', content: prompt },
  ]) {
    if (content === '') continue
    const last = messages.at(-1)
    if (last?.role === role) last.content = `${last.content}\n\n${content}`
    else messages.push({ role, content })
  }
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: '(The conversation so far.)' })

  return messages
}
