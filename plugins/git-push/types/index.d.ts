export type Unpushed = {
  branch: string
  // Whether the branch tracks origin/<branch>; false for a branch never pushed.
  isPublished: boolean
  ahead: number
}

export type PullRequest = {
  id: number
  title: string
  url: string
  // The branch it was found for: a pull request is shown only while that branch is checked out.
  branch: string
  projectId: string
  status: 'active' | 'completed' | 'abandoned'
  isDraft: boolean
  hasConflicts: boolean
  approved: number
  reviewers: number
  rejectedBy: string[]
  changesRequestedBy: string[]
  checks: { passed: number; failed: number; running: number }
}

export type PullRequestDraft = { title: string; description: string; target: string }

declare module 'claude-code' {
  interface PluginState {
    'git-push': {
      unpushed: Unpushed | null
      isPushing: boolean
      // The branch, when it is on origin with nothing left to push in an Azure DevOps repository.
      readyBranch: string | null
      pull: PullRequest | null
      draft: PullRequestDraft | null
      // The branches the draft can merge into, the one picked for it first.
      bases: string[]
      busy: string | null
      notice: string | null
    }
  }
}
