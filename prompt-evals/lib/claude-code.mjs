import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// Asks the model through headless Claude Code (`claude -p`), so the calls run on your Claude subscription, the way
// the plugin's own calls do. --safe-mode leaves out your plugins, hooks, CLAUDE.md and MCP servers, so jira-log
// records nothing and no repository context leaks in; --tools "" lets the model only answer. The model sees
// Claude Code's own system prompt, as in a real fork.

const TIMEOUT_MS = 10 * 60_000
// An empty folder, so the environment Claude Code describes to the model holds no repository.
const CWD = join(tmpdir(), 'prompt-evals-claude-code')

const versionOf = name => name.split('.').map(Number)
const isNewer = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// CLAUDE_PATH, then claude on PATH, then the newest copy the Claude desktop app keeps.
function claudePath() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) if (dir !== '' && existsSync(join(dir, name))) return join(dir, name)
  }
  const bundled = join(process.env.APPDATA ?? '', 'Claude', 'claude-code')
  if (process.platform === 'win32' && existsSync(bundled)) {
    const versions = readdirSync(bundled).filter(one => /^\d+(\.\d+)*$/.test(one))
    const newest = versions.reduce((best, one) => (best === null || isNewer(one, best) ? one : best), null)
    if (newest !== null) {
      for (const build of readdirSync(join(bundled, newest))) {
        if (existsSync(join(bundled, newest, build, 'claude.exe'))) return join(bundled, newest, build, 'claude.exe')
      }
    }
  }
  throw new Error('Claude Code was not found: put claude on PATH, or set CLAUDE_PATH to it')
}

// claude -p takes one message, so earlier turns go in as a transcript ahead of the prompt.
function messageOf(messages) {
  if (messages.length === 1) return messages[0].content
  const earlier = messages
    .slice(0, -1)
    .map(({ role, content }) => `<${role}>\n${content}\n</${role}>`)
    .join('\n\n')

  return `This is our conversation so far:\n\n<conversation>\n${earlier}\n</conversation>\n\n${messages.at(-1).content}`
}

function run(path, args, input) {
  return new Promise((resolve, reject) => {
    // Without the API's variables Claude Code signs in with your subscription, not a key.
    const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env
    const child = spawn(path, args, { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const [out, err] = [[], []]
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.end(input, 'utf8')
  })
}

export async function viaClaudeCode({ model, effort }, { system, messages }) {
  mkdirSync(CWD, { recursive: true })
  const args = [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--model',
    model,
    '--effort',
    effort,
    // The judge brings its own instructions; a draft keeps Claude Code's system prompt.
    ...(system === undefined ? [] : ['--system-prompt', system]),
  ]
  let answer
  try {
    answer = await run(claudePath(), args, messageOf(messages))
  } catch (error) {
    return { error: `Claude Code did not start: ${error instanceof Error ? error.message : String(error)}` }
  }
  let result
  try {
    result = JSON.parse(answer.stdout)
  } catch {
    return { error: `Claude Code exited with ${answer.code}: ${(answer.stderr || answer.stdout).trim().slice(0, 500)}` }
  }
  const { input_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0, output_tokens = 0 } =
    result.usage ?? {}
  const prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  const tokenUsage = { prompt, completion: output_tokens, total: prompt + output_tokens, numRequests: 1 }
  const metadata = { model: Object.keys(result.modelUsage ?? {}).join(', ') || model, stopReason: result.stop_reason }
  if (result.is_error || result.subtype !== 'success') {
    return { error: `Claude Code: ${result.result || result.subtype} (${result.api_error_status ?? 'no status'})`, tokenUsage, metadata }
  }
  if (result.stop_reason === 'refusal') return { error: 'refused', tokenUsage, metadata }

  return { output: result.result ?? '', tokenUsage, metadata }
}
