#!/usr/bin/env node
// Runs prompt suites, each on its own so one suite's prompts never meet another's cases.
//
//   npm run eval                                   every suite, the working tree's prompts only
//   npm run eval -- git-push                       one plugin's suites
//   npm run eval -- pull-request.draft --repeat 3  one suite, each case three times
//   npm run eval -- --baseline main                also the prompts as they are at main, side by side
//   npm run eval -- --api                          the Claude API instead of Claude Code on your subscription
//
// Anything else is passed to `promptfoo eval`. See the results with `npm run eval:view`.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EVALS = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('../../node_modules/promptfoo/dist/src/entrypoint.js', import.meta.url))

const suites = readdirSync(EVALS, { withFileTypes: true })
  .filter(plugin => plugin.isDirectory() && !['lib', 'conversations', '.cache'].includes(plugin.name))
  .flatMap(plugin =>
    readdirSync(join(EVALS, plugin.name), { withFileTypes: true })
      .filter(prompt => prompt.isDirectory() && existsSync(join(EVALS, plugin.name, prompt.name, 'promptfooconfig.yaml')))
      .map(prompt => ({ plugin: plugin.name, prompt: prompt.name, name: `${plugin.name}/${prompt.name}` })),
  )

const args = process.argv.slice(2)
const baselineAt = args.indexOf('--baseline')
const baseline = baselineAt === -1 ? null : args[baselineAt + 1]
if (baselineAt !== -1 && (baseline === undefined || baseline.startsWith('-'))) {
  console.error('--baseline needs a git ref, such as main or a commit')
  process.exit(1)
}
const isApi = args.includes('--api')
const rest = args.filter((arg, i) => arg !== '--api' && (baselineAt === -1 || (i !== baselineAt && i !== baselineAt + 1)))
const isSuite = arg => suites.some(one => [one.name, one.plugin, one.prompt].includes(arg))
const picked = rest.filter(isSuite)
const passed = rest.filter(arg => !isSuite(arg))
const chosen = picked.length === 0 ? suites : suites.filter(one => [one.name, one.plugin, one.prompt].some(id => picked.includes(id)))

if (chosen.length === 0) {
  console.error('No suites found under prompt-evals/<plugin>/<prompt>/promptfooconfig.yaml')
  process.exit(1)
}

let failed = false
for (const suite of chosen) {
  console.log(`\n== ${suite.name}${baseline === null ? '' : ` (against ${baseline})`}`)
  const run = spawnSync(
    process.execPath,
    [
      CLI,
      'eval',
      '-c',
      join(EVALS, suite.plugin, suite.prompt, 'promptfooconfig.yaml'),
      '--description',
      suite.name,
      ...(baseline === null ? ['--filter-prompts', '^current$'] : []),
      ...passed,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(baseline === null ? {} : { PROMPT_BASELINE: baseline }),
        ...(isApi ? { PROMPT_EVALS_BACKEND: 'api' } : {}),
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
      },
    },
  )
  failed ||= run.status !== 0
}
process.exit(failed ? 1 : 0)
