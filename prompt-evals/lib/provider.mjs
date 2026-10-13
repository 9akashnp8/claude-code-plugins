import Anthropic from '@anthropic-ai/sdk'

import { viaClaudeCode } from './claude-code.mjs'

// The promptfoo provider every suite uses, for the drafts and for the llm-rubric grader. It sends the messages a
// suite's prompt function built, the way the plugin's ask() does through the session's model.
//
// config: backend, model (default claude-opus-5-5), effort (default xhigh, Claude Code's own default; match the
// effort your sessions run at), maxTokens (default 16000, the api backend only).
//
// backend: claude-code (the default) runs headless Claude Code on your Claude subscription; api calls the Claude API
// with ANTHROPIC_API_KEY or an `ant auth login` profile, at API prices. PROMPT_EVALS_BACKEND overrides it, and
// `npm run eval -- --api` sets that.

const isMessages = value =>
  Array.isArray(value) && value.every(one => typeof one?.role === 'string' && one.content !== undefined)

// A suite's prompt function hands over JSON messages; promptfoo's graders send messages with a system turn, or text.
function requestOf(prompt) {
  let parsed
  try {
    parsed = JSON.parse(prompt)
  } catch {}
  if (!isMessages(parsed)) return { messages: [{ role: 'user', content: prompt }] }
  const system = parsed.filter(one => one.role === 'system').map(one => one.content).join('\n\n')

  return { ...(system === '' ? {} : { system }), messages: parsed.filter(one => one.role !== 'system') }
}

export default class ClaudeProvider {
  constructor(options = {}) {
    this.config = { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'xhigh', maxTokens: 16000, ...options.config }
    if (process.env.PROMPT_EVALS_BACKEND) this.config.backend = process.env.PROMPT_EVALS_BACKEND
    if (!['claude-code', 'api'].includes(this.config.backend)) throw new Error(`unknown backend ${this.config.backend}`)
    this.label = options.label
    this.providerId = options.id ?? 'claude'
  }

  // The backend is part of the id, so promptfoo never answers one backend's request from the other's cache.
  id() {
    return `${this.providerId}:${this.config.backend}:${this.config.model}:${this.config.effort}`
  }

  callApi(prompt) {
    const request = requestOf(prompt)

    return this.config.backend === 'api' ? this.viaApi(request) : viaClaudeCode(this.config, request)
  }

  async viaApi(request) {
    const { model, effort, maxTokens } = this.config
    this.client ??= new Anthropic()
    // Opus, Sonnet 5.5 and Fable refusals fall back server-side to the model Anthropic picks for the category;
    // metadata.model says when another model answered. Haiku has no fallback.
    const fallback = model.startsWith('claude-haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    try {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        output_config: { effort },
        ...fallback,
        ...request,
      })
      const { input_tokens: input = 0, output_tokens: output = 0 } = response.usage ?? {}
      const tokenUsage = { prompt: input, completion: output, total: input + output, numRequests: 1 }
      const metadata = { model: response.model, stopReason: response.stop_reason }
      if (response.stop_reason === 'refusal') {
        return { error: `refused (${response.stop_details?.category ?? 'no category'})`, tokenUsage, metadata }
      }
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (response.stop_reason === 'max_tokens') return { error: 'cut off at maxTokens', output: text, tokenUsage, metadata }

      return { output: text, tokenUsage, metadata }
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return { error: `the API key was refused: ${error.message}` }
      if (error instanceof Anthropic.RateLimitError) return { error: `rate limited: ${error.message}` }
      if (error instanceof Anthropic.APIError) return { error: `API error ${error.status}: ${error.message}` }
      // No credentials at all surfaces here, before any request: set ANTHROPIC_API_KEY or run `ant auth login`.
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
