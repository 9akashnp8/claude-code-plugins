#!/usr/bin/env node
// Turns a real Claude Code session into a conversation fixture, so cases are built from work that happened.
//
//   npm run eval:case -- <session id | path to .jsonl> <name> [--last <turns>] [--force]
//
// Writes prompt-evals/conversations/<name>.json. It drops subagent turns, thinking and <system-reminder> blocks,
// shortens tool output, and redacts what it recognises (emails, home folders, tokens). It cannot know your
// internal hostnames or customer names: read the file before you commit it.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONVERSATIONS = fileURLToPath(new URL('../conversations/', import.meta.url))
const RESULT_LIMIT = 400
const INPUT_LIMIT = 200

function transcriptPath(source) {
  if (source.endsWith('.jsonl')) return source
  const projects = join(homedir(), '.claude', 'projects')
  const found = readdirSync(projects)
    .map(project => join(projects, project, `${source}.jsonl`))
    .find(existsSync)
  if (found === undefined) throw new Error(`no session ${source} under ${projects}`)

  return found
}

function gitConfig(key) {
  try {
    return execFileSync('git', ['config', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const REDACTIONS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'me@example.com'],
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1me'],
  [/(\/(?:Users|home)\/)[^/\s"']+/g, '$1me'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[token]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [token]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]'],
  // Who you are on this machine and in git, wherever it shows up: project folder names, commit authors.
  ...[userInfo().username, gitConfig('user.name'), gitConfig('user.email')]
    .filter(one => one.length > 2)
    .map(one => [new RegExp(one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'me']),
]

let redacted = 0

function clean(text) {
  let out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, (...match) => {
      redacted += 1
      return replacement.replace(/\$(\d)/g, (_, n) => match[Number(n)] ?? '')
    })
  }

  return out.trim()
}

const shorten = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text)

function inputOf(input = {}) {
  const shown = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description
  return clean(shorten(typeof shown === 'string' ? shown : JSON.stringify(input), INPUT_LIMIT))
}

function resultOf(content) {
  const text = typeof content === 'string' ? content : (content ?? []).map(one => one.text ?? '').join('\n')
  return clean(shorten(text.trim(), RESULT_LIMIT))
}

function turnsIn(lines) {
  const turns = []
  const uses = new Map()
  const push = (role, part) => {
    const last = turns.at(-1)
    const turn = last?.role === role ? last : turns[turns.push({ role, text: '', toolUses: [] }) - 1]
    if (part.text) turn.text = [turn.text, part.text].filter(Boolean).join('\n\n')
    if (part.toolUse) turn.toolUses.push(part.toolUse)
  }
  for (const line of lines) {
    const record = JSON.parse(line)
    if ((record.type !== 'user' && record.type !== 'assistant') || record.isSidechain || record.isMeta) continue
    const { content } = record.message ?? {}
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? [])
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = clean(block.text ?? '')
        if (text !== '') push(record.type, { text })
      } else if (block.type === 'tool_use') {
        const toolUse = { name: block.name, input: inputOf(block.input) }
        uses.set(block.id, toolUse)
        push('assistant', { toolUse })
      } else if (block.type === 'tool_result') {
        const toolUse = uses.get(block.tool_use_id)
        if (toolUse !== undefined) toolUse.result = resultOf(block.content)
      }
    }
  }

  return turns.map(({ role, text, toolUses }) => (toolUses.length === 0 ? { role, text } : { role, text, toolUses }))
}

const [source, name, ...flags] = process.argv.slice(2)
if (source === undefined || name === undefined || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: npm run eval:case -- <session id | path to .jsonl> <name in kebab-case> [--last <turns>] [--force]')
  process.exit(1)
}
const last = flags.includes('--last') ? Number(flags[flags.indexOf('--last') + 1]) : Infinity
const target = `${CONVERSATIONS}${name}.json`
if (existsSync(target) && !flags.includes('--force')) {
  console.error(`${target} already exists; pass --force to replace it`)
  process.exit(1)
}

const path = transcriptPath(source)
const turns = turnsIn(readFileSync(path, 'utf8').split('\n').filter(Boolean)).slice(-last)
writeFileSync(target, `${JSON.stringify({ source: `session ${basename(path, '.jsonl')}`, turns }, null, 2)}\n`)

const hosts = [...new Set(JSON.stringify(turns).match(/\b(?:[a-z0-9-]+\.)+(?:local|corp|internal|lan|net|com|io)\b/gi) ?? [])]
console.log(`Wrote ${turns.length} turns to ${target}, with ${redacted} redactions.`)
if (hosts.length > 0) console.log(`Hostnames to check before committing: ${hosts.slice(0, 20).join(', ')}`)
console.log('Read the file before you commit it: anything the redactions missed goes into git history.')
