# Pi Laguna Plan Runner

A Pi package for weaker or low-context coding models, especially Poolside Laguna M.
It turns an approved read-only plan into a deterministic, sequential execution loop:

- Pi explores the project without write tools.
- A structured tool presents the plan for explicit approval.
- The extension writes `PLAN.md`, `RALPH.md`, `OPEN_QUESTIONS.md`, and hidden state.
- `/laguna-run` starts one fresh Pi process for one task.
- The TypeScript-free controller, not a model, chooses the next task and runs verification.
- Only the controller checks a task off, and only after its command exits successfully.
- A failed task gets one fresh retry; then the loop stops with logs.

The generated `RALPH.md` is the worker contract adapted for this runner. The package
does not require a separate Ralph-loop or DeepSeek planning extension.

## Install

From GitHub:

```sh
pi install git:github.com/lsanpablo/pi-laguna-plan-runner@v0.1.0
```

To install only for the current project:

```sh
pi install -l git:github.com/lsanpablo/pi-laguna-plan-runner@v0.1.0
```

To try a local checkout:

```sh
pi install /absolute/path/to/pi-laguna-plan-runner
```

Restart Pi after installation, or run `/reload` in an existing session.

Pi packages execute code with your user permissions. Review
[`extensions/index.js`](extensions/index.js) and
[`extensions/runner.js`](extensions/runner.js) before installation.

## Use

Start planning:

```text
/laguna-plan Add retry handling to the import job, including tests
```

The model inspects the project read-only. It can ask questions in the conversation.
When ready, it submits a structured plan. Pi shows the task list and every command
that will later execute. Approve it to write the plan files; reject it to revise.

The final response gives a path such as:

```text
.pi/plans/add-retry-handling
```

Start that plan:

```text
/laguna-run .pi/plans/add-retry-handling
```

With no path, `/laguna-run` selects the most recently generated plan. Stop an active
child with:

```text
/laguna-stop
```

The runner uses the parent Pi session's current provider, model ID, and thinking
level for every child. API keys, custom provider configuration, deployment URL,
and TLS environment variables are inherited from the parent process. It does not
copy keys into plan files or logs.

## Files and recovery

Each plan lives under `.pi/plans/<slug>/`:

```text
PLAN.md
RALPH.md
OPEN_QUESTIONS.md
.laguna-plan.json
.laguna-run.json
logs/
```

`PLAN.md` is the human-readable source of progress. `.laguna-plan.json` preserves
the approved task inputs, while `.laguna-run.json` records attempts and controller
events. Re-run `/laguna-run <path>` after fixing an external blocker; checked tasks
are skipped. If a task already consumed both attempts, revise the plan or reset its
attempt counter intentionally before resuming.

Workers are told not to edit plan state. The controller also snapshots `PLAN.md`
before each worker and restores it if the worker changes it.

## Commands

- `/laguna-plan <request>` — enter read-only planning and send the request
- `/laguna-plan-exit` — leave planning without writing a plan
- `/laguna-run [plan path]` — execute an approved plan
- `/laguna-stop` — stop the current child

## Development

```sh
npm test
npm run check
```

Tests use fake workers and fake verification functions. They do not call an AI API
or modify a real project.
