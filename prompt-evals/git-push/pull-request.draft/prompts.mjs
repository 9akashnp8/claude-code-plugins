import { forkMessages } from '../../lib/fork.mjs'
import { loadPrompts } from '../../lib/load.mjs'

// A case's vars are draftPrompt's input plus the conversation the fork would have read.
async function build(ref, { conversation, ...input }) {
  const { draftPrompt } = await loadPrompts('git-push', ref)

  return forkMessages(conversation, draftPrompt(input))
}

export const current = ({ vars }) => build(null, vars)

export const baseline = ({ vars }) => build(process.env.PROMPT_BASELINE ?? 'main', vars)
