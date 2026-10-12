import type { Unpushed } from '../types'

export const REMOTE = 'origin'

// How often git is asked again, for commits made outside Claude (the app's Commit button, a terminal).
export const POLL_MS = 5_000

export const PUSH_TIMEOUT_MS = 5 * 60_000

// Commits on HEAD that are on no branch of origin: what a first push of a new branch sends.
export const NEW_COMMITS = ['rev-list', '--count', 'HEAD', '--not', `--remotes=${REMOTE}`]

export const PUSH = ['push', '--set-upstream', REMOTE, 'HEAD']

// Brings origin's branches up to date, dropping those deleted there, before a base is picked from them.
export const FETCH = ['fetch', '--prune', REMOTE]

export const FETCH_TIMEOUT_MS = 60_000

// Each branch of origin and how far it is from HEAD, in one call: "<name> <its commits HEAD lacks> <HEAD's commits it lacks>".
// %(ahead-behind) needs git 2.41; an older git refuses it, and the pull request falls back to the default branch.
export const BRANCH_DISTANCES = ['for-each-ref', '--format=%(refname:lstrip=3) %(ahead-behind:HEAD)', `refs/remotes/${REMOTE}`]

// How many branches the pull request pane offers to merge into.
export const BASE_CHOICES = 8

export type Distance = { branch: string; theirs: number; ours: number }

export function distancesOf(stdout: string): Distance[] {
  return stdout
    .split('\n')
    .map(line => line.trim().split(' '))
    .filter(parts => parts.length === 3)
    .map(([branch = '', theirs = '', ours = '']) => ({ branch, theirs: Number(theirs), ours: Number(ours) }))
    .filter(one => one.branch !== '' && Number.isInteger(one.theirs) && Number.isInteger(one.ours))
}

// The branches a pull request from `own` can merge into, the one it was most likely cut from first: the fewest of
// HEAD's commits missing, then the fewest commits of its own, then the default branch. A branch that already holds
// every commit of HEAD is no base. The default branch is always offered, last when it is not near.
export function basesOf(distances: readonly Distance[], own: string, defaultBranch: string, limit = BASE_CHOICES) {
  const near = distances
    .filter(one => one.branch !== 'HEAD' && one.branch !== own && one.ours > 0)
    .sort(
      (a, b) =>
        a.ours - b.ours ||
        a.theirs - b.theirs ||
        Number(b.branch === defaultBranch) - Number(a.branch === defaultBranch) ||
        a.branch.localeCompare(b.branch),
    )
    .map(one => one.branch)
    .slice(0, limit)

  return near.includes(defaultBranch) ? near : [...near, defaultBranch]
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export const describe = ({ branch, isPublished, ahead }: Unpushed) =>
  isPublished
    ? `${branch} · ${plural(ahead, 'commit')} not pushed`
    : `${branch} · not on ${REMOTE} yet · ${plural(ahead, 'commit')}`

export const isSame = (a: Unpushed | null, b: Unpushed | null) =>
  a === b || (a !== null && b !== null && a.branch === b.branch && a.isPublished === b.isPublished && a.ahead === b.ahead)

// The lines of git's stderr that say why a push failed, without its hints.
export function failureOf(stderr: string) {
  const lines = stderr.split('\n').map(line => line.trim()).filter(line => line !== '')
  const reasons = lines.filter(line => /^(fatal|error|remote: error):|^!/.test(line))

  return (reasons.length > 0 ? reasons : lines.slice(-1)).join(' ') || 'git exited with an error'
}
