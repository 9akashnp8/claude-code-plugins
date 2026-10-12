export type JiraIssue = { key: string; summary: string; status: string; statusCategory: string }

export type JiraUpdate = { notes: string[] }

// `sprint` is the id of the sprint the issue goes into once created; null leaves it in the backlog.
export type JiraNewIssue = {
  summary: string
  description: string
  issueType: string
  sprint: number | null
}

export type JiraSprint = { id: number; name: string; state: 'active' | 'future' }

export type JiraTransition = { id: string; name: string; to: string }

export type JiraSuggestion = { id: string; to: string; reason: string }

// `earlier` counts unposted actions on earlier days; progress saved before it existed has none.
export type JiraProgress = {
  day: string
  actions: number
  postedActions: number
  postedAt: number | null
  earlier?: number
}

export type JiraView = 'setup' | 'pick' | 'draft' | 'create' | 'move'

declare module 'claude-code' {
  interface PluginState {
    'jira-log': {
      view: JiraView
      isConfigured: boolean
      isSkipped: boolean
      isProgressHidden: boolean
      progress: JiraProgress | null
      link: JiraIssue | null
      issues: JiraIssue[]
      draft: JiraUpdate | null
      suggestion: JiraSuggestion | null
      newIssue: JiraNewIssue | null
      issueTypes: string[]
      sprints: JiraSprint[]
      transitions: JiraTransition[]
      busy: string | null
      notice: string | null
    }
  }
}
