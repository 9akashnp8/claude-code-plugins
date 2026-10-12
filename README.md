# claude-code-auto-jira-log

A Claude Code plugin that keeps Jira Cloud up to date with the work you do in Claude Code, a second one, [git-push](#git-push), that pushes your commits from a button, and a third, [worktree-hooks](#worktree-hooks), that starts each worktree from the latest remote branch.

- **Link** a worktree to a Jira issue: pick one of your open issues, type a key, or create a new issue drafted from the conversation.
- **Record** the day's work on that issue as you go: files edited, commits, test runs, pull requests, and Artifacts published.
- **Post** one daily comment per issue: a few plain notes on what was done, and on any problem, how it was resolved or what it waits on. Claude drafts it from that record and the conversation, and you review it before it is sent. The notes carry no sections, so a weekly report built from the comments can sort the work its own way.
- **See** at a glance whether your work is in Jira: a line above the prompt shows the linked issue, its status, and how many actions are recorded but not yet posted, today's and any earlier day's, with a button to draft the update.
- **Move** the issue along: To Do becomes In Progress when you link it, and `/jira update` suggests the next status (In Review once a pull request is up, Done once it is merged) for you to confirm with one press.

Built on Claude Code's function hooks (early access); the API can change between Claude Code releases.

## Install

```
/plugin marketplace add 9akashnp8/claude-code-auto-jira-log
/plugin install jira-log@auto-jira-log
```

## Set up

1. Create an API token at id.atlassian.com > Security > API tokens.
2. Run `/jira setup`, fill in your site URL (`https://your-team.atlassian.net`), email and token, then press **Save and test connection**. Add a project key too if you want to create issues from Claude Code.

The token is encrypted with Windows DPAPI before it is stored, so it opens only for your Windows user on that machine. Token storage needs Windows PowerShell.

## Use

| Command | What it does |
| --- | --- |
| `/jira` | Shows which issue this worktree is linked to |
| `/jira setup` | Opens the connection form |
| `/jira link [KEY]` | Links this worktree to an issue; without a key, opens the picker |
| `/jira new [what for]` | Drafts a ticket (a title and a short description) from the conversation, focused on what you type after `new` if anything: pick its type and sprint, revise it, then create and link it |
| `/jira new --manual` | Opens a blank ticket form (title, description, type, sprint) and never asks the model; the band's **Write it myself** button does the same. Every drafted ticket can be edited in the same form |
| `/jira update` | Drafts today's comment in the Jira pane: revise it, post it or discard it |
| `/jira status` | Moves the linked issue to any status its workflow allows, such as Done |
| `/jira unlink` | Removes the link |

A new issue goes into the project's current sprint unless you pick a future sprint or **Backlog** in the form. The sprints are the active and future ones on the project's scrum boards. When the site has no Jira Software, or the project has no scrum board, the form shows no sprint and the issue goes to the backlog.

Running `/jira update` again on the same day replaces that day's comment, unless someone edited it in Jira since; then a new comment is added.

A day whose work never reached Jira is not lost: the next `/jira update`, within 14 days, drafts that work into its comment along with the day's own, and posting it marks the earlier day as covered.

Linking a To Do issue looks for a transition into a status named In Progress (any case); when the workflow has none, a toast says so and the issue stays where it is.

`/jira update` only suggests moves the issue's workflow allows from its current status, and nothing moves until you press the button. Its evidence is the conversation and the day's record, which notes pull and merge requests opened from Claude Code by `gh pr create`, `glab mr create`, `az repos pr create`, or an MCP tool such as `create_pull_request`. A pull request opened in the browser counts once you mention it in the conversation.

## git-push

A second plugin in this marketplace: push the branch and open its pull request from buttons above the prompt, then follow the pull request there until it is merged.

```
/plugin install git-push@auto-jira-log
```

### Push

When the branch has commits that are not on `origin`, the line above the prompt says so, with a **Push** button:

- `feature/export · not on origin yet · 2 commits`: the branch was never pushed. **Push** runs `git push --set-upstream origin HEAD`, so `origin/feature/export` is created and tracked.
- `feature/export · 1 commit not pushed`: the branch tracks `origin/feature/export` and is ahead of it.

A toast says whether the push worked, or the line from git that says why not. The plugin checks git after each turn and every 5 seconds, so commits made with the app's Commit button or in a terminal show up too. The push runs with your own git credentials and never waits on a terminal prompt. Claude Code runs git for plugins with the repository's hooks off, so a `pre-push` hook does not run on this push.

### Pull requests (Azure DevOps)

When `origin` is an Azure DevOps repository (Azure DevOps Server, such as `https://server/tfs/Collection/Project/_git/Repo`, or Azure DevOps Services) and the branch is on it with nothing left to push, the line shows **Create PR**:

1. The plugin fetches `origin` and picks the branch to merge into: the branch yours was most likely cut from. That is the `origin` branch missing the fewest of your branch's commits, then the one with the fewest commits of its own, with the repository's default branch winning a tie. A branch cut from `dev` merges into `dev`. With git older than 2.41, which cannot measure this, it uses the default branch.
2. Claude drafts a title and description from the commits and changed files between that branch and yours, using the conversation only for why the change is needed and how it was tested. A Jira key named in the conversation starts the title.
3. The draft opens in the Pull request pane: pick another branch under **Into** (the draft is written again for it), edit the title, ask for a revision in your own words, then press **Create pull request**.
4. A note in the conversation records the pull request, so Claude and `jira-log`'s next update know it is up.

From then on the line follows the pull request, checking every minute: `PR #12 · Active · 1 of 2 approved · checks running`. Conflicts, a rejection or a failed check turn it red, changes requested yellow, and a merged pull request shows **Merged** in the merge purple. `PR #12` opens it in the browser. A pull request opened in the browser shows up too.

Signing in needs no setup. The plugin asks git for the credential it uses for `origin` (`git credential fill`), then sends requests through Windows PowerShell: first as Basic sign-in (a personal access token), then as Windows sign-in with the same credential (a domain password), and with no stored credential as your Windows account. The credential stays in memory and goes to PowerShell on its standard input, never on a command line. Requests use REST API version 6.0, which Azure DevOps Server 2020 and later answer. Pull requests need Windows.

When both plugins are installed, their lines stack in the band above the prompt.

## worktree-hooks

A third plugin in this marketplace: start every worktree from the latest commit of the branch it is made from, not from whatever copy of that branch this machine fetched last.

```
/plugin install worktree-hooks@auto-jira-log
```

It registers `WorktreeCreate`, `WorktreeRemove` and `SessionStart` command hooks. `claude --worktree` always branches from the default branch. A `WorktreeCreate` hook replaces Claude Code's own worktree creation, so `worktree-create.sh` does all of it:

1. Finds the main checkout and the default branch from `origin/HEAD` (`main` when that is not set).
2. Runs `git fetch origin <branch>`. When the fetch fails, for example offline, it carries on from the cached `origin/<branch>`.
3. Runs `git worktree add` for `.claude/worktrees/<name>` on a new branch, `worktree-<name>`, from `origin/<branch>`.

`worktree-remove.sh` removes the worktree and deletes its `worktree-*` branch, because Claude Code never deletes the branch of a worktree a hook created.

The desktop app's Code tab makes its worktrees itself and does not run `WorktreeCreate`. It branches from the branch picked in the branch selector, as this machine last fetched it, which can be behind. For those, `session-start.sh` catches up when a new session starts in a worktree:

1. Finds the branch the worktree was made from. The desktop app records it as `sourceBranch` in its session file under `%APPDATA%Claudeclaude-code-sessions`. That file belongs to the app and is not documented, so when it is missing or changes shape, the hook falls back to the one branch, other than the worktree's own, that points at the worktree's commit. When several do, it cannot tell them apart and leaves the worktree alone.
2. Fetches that branch from `origin` and fast-forwards the worktree's branch to it, then tells Claude in one line.

It leaves the worktree alone when the session is resumed, cleared or compacted rather than new, when there are uncommitted changes, when the branch has commits of its own, or when the branch is not on `origin`. Set `WORKTREE_HOOKS_SYNC=0` to turn this off and only log.

Things to know:

- The hooks run in every repository where the plugin is enabled, and a broken script stops worktrees from being created in all of them.
- `.worktreeinclude` is not processed when a hook creates the worktree, so files such as `.env` are not copied across.
- Add `.claude/worktrees/` to the repository's `.gitignore`.
- The hooks are shell-form commands, which Claude Code runs through Git Bash on Windows, so they need Git for Windows. They are not started as `bash` directly, because on Windows that name can resolve to WSL's launcher.
- `WorktreeCreate` fires for `claude --worktree`, `isolation: "worktree"` subagents and background sessions, not for the desktop app's Code tab.
- In a worktree session, `CLAUDE_PROJECT_DIR` and a hook's working directory are the main checkout. Only the `cwd` in the hook's input is the worktree.

### Debugging

Every hook appends to `~/.claude/logs/worktree-hooks.log` (set `WORKTREE_HOOKS_LOG` to move it): its input, the Claude Code entry point (`CLAUDE_CODE_ENTRYPOINT`, such as `cli` or `claude-desktop`), which bash ran it, each step, and the line a failure stopped at. `SessionStart` also logs the session's folder, branch and whether it is a linked worktree, the branch it was made from and how that was found, then either the fast-forward or the reason it skipped one (`no sync: …`).

To find out whether a way of starting a session runs `WorktreeCreate`, start one and read the log:

- A `SessionStart` entry for the new worktree with no `WorktreeCreate` entry before it: the worktree was made without the hook. Its branch is not named `worktree-<name>`.
- No `SessionStart` entry either: the plugin's hooks did not load in that session. Check `/hooks` and the Errors tab of `/plugin`.
- A `WorktreeCreate` entry ending in `failed:`: the hook ran and stopped at the logged line.

For Claude Code's own record of a hook, run it from the terminal with a debug log, then search the file for `Hook `:

```
claude --worktree hook-check --debug-file ./claude-debug.txt
```

To run a script by hand, pipe it the JSON Claude Code would send:

```
echo '{"name":"hook-check"}' | CLAUDE_PROJECT_DIR="$PWD" bash plugins/worktree-hooks/scripts/worktree-create.sh
```

## hook-logger

A debugging plugin: it logs every hook event Claude Code fires, so you can see which events fire, when, and with what input. It changes nothing.

```
/plugin install hook-logger@auto-jira-log
```

Each event appends two lines to `~/.claude/logs/hook-events.log` (set `HOOK_LOGGER_LOG` to move it): the time, event name, Claude Code entry point (`cli` or `claude-desktop`) and project folder, then the full JSON input.

It registers all 33 events in the [hooks reference](https://code.claude.com/docs/en/hooks), with no matcher, so each fires on every occurrence. Two of them cannot just log: registering `WorktreeCreate` or `WorktreeRemove` replaces Claude Code's own worktree creation or removal. So after logging, the plugin does that work itself, and adds a `result=` line saying what it did:

- `WorktreeCreate` makes `.claude/worktrees/<name>` on a new branch, `worktree-<name>`, from the project's current `HEAD`, and prints its path. Claude Code's own default starts from `origin/<default branch>` instead. `.worktreeinclude` is not processed.
- `WorktreeRemove` removes the worktree and its `worktree-*` branch.

Don't enable it alongside `worktree-hooks`: both would answer `WorktreeCreate`.

`FileChanged` only fires for files named in its matcher, so with none it may never fire. Every hook starts Git Bash on Windows, which adds a little time to each tool call: disable the plugin when you are done.

## Develop

```
claude plugin validate plugins/jira-log
claude plugin test plugins/jira-log
claude --plugin-dir plugins/jira-log
```

The same commands work for `plugins/git-push`, `plugins/worktree-hooks` and `plugins/hook-logger`.
