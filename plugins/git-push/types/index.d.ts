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
  // The build validation policies whose last build failed, each with that build.
  failedBuilds: FailedBuild[]
}

export type FailedBuild = { evaluationId: string; buildId: number }

export type FailedStep = {
  name: string
  // The step's own error lines, as the timeline reports them.
  errors: string[]
  // The last lines of its log, timestamps dropped; empty for a job or stage, which has none.
  log: string
}

export type BuildFailure = { buildId: number; definition: string; url: string; steps: FailedStep[] }

// Where a fix of the pull request's failed build has got to.
export type BuildFix = { stage: 'reading' | 'fixing' | 'pushing' }

// What Claude said a person must do about the failed build, and the failures it was about.
export type Escalation = { reason: string; keys: string[] }

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
      fix: BuildFix | null
      escalation: Escalation | null
    }
  }
}
