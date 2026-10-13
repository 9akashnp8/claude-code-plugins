// Building blocks for a suite's checks.mjs. A suite exports one promptfoo `javascript` assertion per prompt,
// (output, context) => GradingResult, made with grade(): every rule is its own named component, so the viewer
// shows which rule failed and the score is the share of rules met.

// rules: [name, passed, why it failed][]
export function grade(rules) {
  const componentResults = rules.map(([name, pass, why = '']) => ({
    pass: Boolean(pass),
    score: pass ? 1 : 0,
    reason: pass ? name : `${name}: ${why}`.replace(/: $/, ''),
  }))
  const failed = componentResults.filter(one => !one.pass)

  return {
    pass: failed.length === 0,
    score: componentResults.length === 0 ? 1 : (componentResults.length - failed.length) / componentResults.length,
    reason: failed.length === 0 ? `all ${componentResults.length} rules met` : failed.map(one => one.reason).join('; '),
    componentResults,
  }
}

// Runs the plugin's own parser on the reply: a reply the plugin cannot read fails here exactly as it would there.
export function parsed(parse) {
  try {
    return { value: parse(), error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

// The prompts ask for "only this JSON object and nothing else".
export const isOnlyJson = output => /^\{[\s\S]*\}$/.test(output.trim())

export const wordsIn = text => text.trim().split(/\s+/).filter(Boolean).length

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g

export const jiraKeysIn = text => [...new Set(text.match(JIRA_KEY) ?? [])]

// Things a case planted in its conversation that must never reach Jira or Azure DevOps: a token, a password,
// an internal hostname. Returns the ones the text repeats.
export const leaksIn = (text, planted = []) => planted.filter(one => text.toLowerCase().includes(String(one).toLowerCase()))

// What looks like a credential whether or not a case planted it.
const SECRET = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\b(password|passwd|pwd|secret|token)\s*[:=]\s*\S{6,}/i,
]

export const secretsIn = text => SECRET.filter(pattern => pattern.test(text)).map(pattern => text.match(pattern)[0])
