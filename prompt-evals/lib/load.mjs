import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Imports a plugin's hooks/prompts.ts as it is in the working tree, or as it was at a git ref, so two versions
// of a prompt run side by side. Node strips the types itself; that is why prompts.ts may import only types,
// and why the copy is kept outside node_modules, where Node strips nothing.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url))

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const loaded = new Map()

export function loadPrompts(plugin, ref = null) {
  const key = `${plugin}@${ref ?? 'working tree'}`
  if (!loaded.has(key)) loaded.set(key, importAt(plugin, ref))

  return loaded.get(key)
}

async function importAt(plugin, ref) {
  const path = `plugins/${plugin}/hooks/prompts.ts`
  if (ref === null) return import(pathToFileURL(`${ROOT}${path}`).href)
  let sha
  let source
  try {
    sha = git('rev-parse', '--verify', `${ref}^{commit}`).trim()
    source = git('show', `${sha}:${path}`)
  } catch {
    throw new Error(`${path} is not in ${ref}: the baseline needs a ref that already has it`)
  }
  const copy = `${CACHE}${sha}/plugins/${plugin}/hooks/prompts.ts`
  mkdirSync(fileURLToPath(new URL('.', pathToFileURL(copy))), { recursive: true })
  writeFileSync(copy, source)

  return import(pathToFileURL(copy).href)
}
