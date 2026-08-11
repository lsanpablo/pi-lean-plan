# Pi Lean Plan

A thin, deterministic planning adapter for
[`@lnilluv/pi-ralph-loop`](https://github.com/lnilluv/pi-ralph-loop).

Lean Plan does not implement a loop. It gives Pi a read-only planning mode and a
structured finalization tool, then writes a native Ralph task package:

- `PLAN.md` — approved sequential tasks with checkboxes
- `PLAN.html` — optional self-contained visual plan generated on demand
- `RALPH.md` — pi-ralph-loop v2 configuration and iteration prompt
- `OPEN_QUESTIONS.md` — completion-gate blocker state
- `check-plan.sh` — acceptance check for task order and completion
- `run-final-verification.sh` — acceptance check run from the project root

`/lean-run` is only a convenience handoff to `/ralph --path`. Ralph remains
responsible for fresh child contexts, iterations, command evidence, completion
gating, status, logs, resume, stop, and cancel.

## Install

Install the Ralph extension first:

```sh
pi install npm:@lnilluv/pi-ralph-loop@2.0.0
```

Version 2.0.0 of pi-ralph-loop declares Node.js 22.22.1 or newer. Check with
`node --version` if npm reports an engine warning.

Then install Lean Plan:

```sh
pi install git:github.com/lsanpablo/pi-lean-plan@v1.3.0
```

For a project-local installation, add `-l` to either command. Restart Pi or run
`/reload` after installation.

Pi packages execute code with your user permissions. Review
[`extensions/index.js`](extensions/index.js) and
[`extensions/core.js`](extensions/core.js) before installation.

## Use

Create an approved plan:

```text
/lean-plan Add retry handling to the import job, including tests
```

The planning model can inspect with read-only tools and ask questions in the
conversation. It submits structured tasks, task verification commands, and one
final verification command. Pi shows them for approval before writing anything.

If you reject a draft, Lean Plan asks whether you want to:

- **Refine with instructions** — enter additions, removals, or corrections in a
  multi-line editor. The model receives those instructions alongside the
  rejected draft and submits a revised version for approval.
- **Continue in chat** — return to the conversation without letting the model
  guess why the draft was rejected.

You can repeat refinement and review as many times as needed. No runnable Ralph
package is written until you approve a draft.

## Save and resume a draft

While read-only planning is active, ask the model to save or defer the plan. The
model can call the narrowly scoped `lean_save_plan` tool even though normal file
writes remain disabled. You can also reject the approval preview and choose
**Save draft and exit**.

The extension writes a readable draft and its structured state under:

```text
.pi/lean-drafts/<plan-name>/DRAFT.md
.pi/lean-drafts/<plan-name>/.lean-plan.json
```

If the model has already submitted a structured plan for review, this command
saves that most recent version without another model turn:

```text
/lean-plan-save
```

In a new Pi session, resume the newest draft:

```text
/lean-plan-resume
```

Or name a draft, its `DRAFT.md`, or an already approved plan that you want to
revise into a new plan:

```text
/lean-plan-resume .pi/lean-drafts/add-retry-handling
/lean-plan-resume .pi/lean-drafts/add-retry-handling/DRAFT.md
/lean-plan-resume .pi/lean-plans/add-retry-handling/PLAN.md
```

Resume restores the complete structured task details and re-enters read-only
planning. Saving never creates `RALPH.md`; approving the resumed plan writes a
new runnable package without modifying the saved draft or the older plan.

## Visual plan

Render the newest generated plan as HTML:

```text
/lean-plan-view
```

Or provide a generated task folder or its `PLAN.md`:

```text
/lean-plan-view .pi/lean-plans/add-retry-handling
/lean-plan-view .pi/lean-plans/add-retry-handling/PLAN.md
```

The command writes or refreshes `PLAN.html` in that task folder. The visualization
contains:

- a responsive sequential task-flow diagram;
- live completion status and verification evidence read from `PLAN.md`;
- detailed task cards with likely files and commands;
- a diagram of Ralph's required completion gate;
- the final verification command.

Tailwind CSS is compiled during package development and embedded directly in the
HTML. The result has no CDN, JavaScript, font, or other network dependency. Run
the command again after Ralph iterations to refresh checkbox progress.

After approval, start the newest plan:

```text
/lean-run
```

Or name the generated task folder:

```text
/lean-run .pi/lean-plans/add-retry-handling
```

That dispatches the native Pi command:

```text
/ralph --path ".pi/lean-plans/add-retry-handling"
```

Use pi-ralph-loop's own commands to operate the run:

```text
/ralph-status .pi/lean-plans/add-retry-handling
/ralph-stop .pi/lean-plans/add-retry-handling
/ralph-cancel .pi/lean-plans/add-retry-handling
/ralph-resume .pi/lean-plans/add-retry-handling
```

## Deterministic completion

The generated `RALPH.md` uses pi-ralph-loop v2's native controls:

- `items_per_iteration: 1`
- `stop_on_error: false`, so incomplete checks provide evidence for the next pass
- a required `LEAN_PLAN_COMPLETE` completion promise
- required `PLAN.md` and `OPEN_QUESTIONS.md` outputs
- acceptance checks for all task checkboxes and the approved final command
- guardrails that protect secret-bearing paths and generated control files

The loop may emit its promise only after all tasks are checked. Ralph then reruns
both acceptance commands; a remaining task, failed final command, missing output,
or unresolved P0/P1 question rejects completion and continues the loop.

## Commands

- `/lean-plan <request>` — enter read-only planning
- `/lean-plan-exit` — leave planning without creating files
- `/lean-plan-save` — persist the most recently submitted structured draft
- `/lean-plan-resume [draft, DRAFT.md, or PLAN.md]` — resume in read-only mode
- `/lean-plan-view [task folder or PLAN.md]` — generate or refresh `PLAN.html`
- `/lean-run [task folder]` — hand an approved plan to pi-ralph-loop

## Development

```sh
npm ci
npm run build:plan-css
npm test
npm run check
```

Tests exercise plan rendering and the generated acceptance scripts. They do not
start Pi, call an AI API, or run a Ralph loop.
