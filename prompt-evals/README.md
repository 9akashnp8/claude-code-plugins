# prompt-evals

Runs the plugins' prompts against fixture inputs with real model calls, so a prompt can be changed and compared
against the last version before it ships. Development only: it lives outside `plugins/`, so none of it is
installed with a plugin.

The plugins' own tests (`claude plugin test`) stub the model and check that each prompt is built and wired
correctly. These suites check what the model writes back.

## Run

```bash
npm install
npm run eval -- pull-request.draft
npm run eval:view
```

`npm run eval` runs every suite. Pick suites by plugin (`git-push`), by prompt (`pull-request.draft`) or both
(`git-push/pull-request.draft`). Anything else goes to `promptfoo eval`, for example:

| Flag | What it does |
| --- | --- |
| `--repeat 3` | Runs each case three times, to see how much the answers vary |
| `--baseline main` | Also runs the prompts as they are at `main` (or any ref), next to the working tree's |
| `--api` | Calls the Claude API instead of Claude Code (see below) |
| `--filter-pattern jira` | Only the cases whose description matches |
| `--no-cache` | Asks the model again instead of reusing an earlier answer to the same request |
| `-w` | Runs again whenever the suite's config changes |

`npm run eval:view` opens promptfoo's viewer: the cases down the side, the prompt versions across the top, each
answer with the rules it met and missed.

### Where the calls go

By default each call runs headless Claude Code (`claude -p`), so it uses your Claude subscription and its usage
limits, as the plugins' own calls do. A case takes three calls: the draft and two judge rubrics. It runs with
`--safe-mode` and no tools: your plugins, hooks, CLAUDE.md and MCP servers stay out, so jira-log records nothing,
and the model can only answer. The runs are not saved as sessions. Claude Code is found on `PATH`, then in the
Claude desktop app's folder; set `CLAUDE_PATH` to use another copy.

`npm run eval -- --api` calls the Claude API instead, with `ANTHROPIC_API_KEY` or an `ant auth login` profile, at
API prices: roughly $0.10 to $0.20 per case on Claude Opus 5.5 at `xhigh`.

The two backends show the model slightly different things. Claude Code sends its own system prompt, as a real
fork does, but takes one message, so the conversation goes in as a transcript ahead of the prompt. The API keeps
the turns as turns but has no Claude Code system prompt. Compare prompt versions on the same backend.

## How a suite is built

```
plugins/<plugin>/hooks/prompts.ts      the prompts and their parsers: what ships
prompt-evals/
  lib/                                 shared by every suite
    provider.mjs                       sends the messages to Claude; also the llm-rubric judge
    claude-code.mjs                    the default backend: headless Claude Code on your subscription
    fork.mjs                           conversation + prompt -> messages, the stand-in for model.fork
    load.mjs                           imports prompts.ts from the working tree or a git ref
    checks.mjs                         grade(), the plugin's parser as a check, leak and credential checks
    from-transcript.mjs                a real Claude Code session -> a conversation fixture
    run.mjs                            npm run eval
  conversations/<name>.json            conversations the cases share
  <plugin>/<feature>.<action>/         one suite per prompt
    promptfooconfig.yaml               the model, the checks every case gets, a rubric
    prompts.mjs                        current and baseline: the case's vars -> messages
    checks.mjs                         this prompt's rules, on top of the plugin's own parser
    cases/<scenario>.yaml              one scenario per file
```

A case's `vars` are the prompt builder's input, plus `conversation`: what the session held when the plugin asked
the model. It names a file in `conversations/`, or is `[]` for the path where there is nothing to fork and the
plugin calls `model.complete` with the prompt alone. A case's `metadata` holds what its checks expect, such as
`jiraKey`, and its `assert` adds rubrics only that case can judge.

The llm-rubric judge sees the answer and the rubric, not the prompt or the conversation. A rubric therefore says
what the case is about (`Pass only if the Testing list mentions the import tests passing...`), or brings in the
case's vars with `{{commits}}`.

### What a run cannot show

`fork.mjs` sends the conversation and then the prompt. A real `model.fork` also carries your CLAUDE.md and the
tool definitions, and with `--api` Claude Code's system prompt too. The conversation fixtures also cut tool output
short. Try a changed prompt once in a real session before shipping it.

## Rules for a plugin's prompts

1. Every prompt the plugin sends is built in `hooks/prompts.ts`, next to the parser for its reply.
   `register.tsx` gathers the data, calls the builder, and never writes prompt text of its own.
2. `prompts.ts` imports only types. That keeps it runnable outside Claude Code, and lets `load.mjs` import an
   old version straight out of git.
3. A builder takes one object, so a case's `vars` are its input as they are. Truncation and other shaping happen
   inside the builder, so a suite sees what the plugin sends.
4. A new prompt gets its suite in the same pull request, at `prompt-evals/<plugin>/<feature>.<action>/`.
5. When a draft comes out wrong in real use, add that scenario as a case before changing the prompt.

`--baseline` works for any ref that already has `prompts.ts`. If a builder's input changes, the old version
cannot read the new cases, so compare against a ref with the same input.

## Add a case from a real session

```bash
npm run eval:case -- <session id> <name> --last 20
```

It reads the session from `~/.claude/projects/` and writes `conversations/<name>.json`. It keeps the last 20
turns, drops subagent turns, thinking and `<system-reminder>` blocks, and shortens tool output. It also redacts
emails, home folders, your username, your git name and email, and anything that looks like a token or password.
It cannot know your internal hostnames, customer names or project details. Read the file before you commit it.

## Add a suite for a new prompt

1. Copy `git-push/pull-request.draft/` to `<plugin>/<feature>.<action>/`.
2. In `prompts.mjs`, load your plugin's prompts and call your builder.
3. In `checks.mjs`, run your parser through `parsed()` and turn the rules your prompt states into `grade()` rows:
   lengths, counts, required headings, what must never appear.
4. Write three to five cases: the usual one, an empty conversation, a conversation about other work, and one with
   something planted that must not leak.
5. In `promptfooconfig.yaml`, write the rubric for the rules code cannot check.
