---
name: lean-plan
description: Create an approved, sequential implementation plan for lean pi-ralph-loop orchestration by exploring a project read-only and submitting standalone tasks with executable verification commands. Use when the user invokes /lean-plan, wants a deterministic PLAN.md and native RALPH.md, or needs a low-context planning workflow before starting a Ralph loop.
---

# Create a Lean Plan

Explore the project without editing it. Produce a compact sequential plan that
the lean pi-ralph-loop can execute one task per fresh worker/validator iteration.

## Plan

1. Identify the requested outcome and affected project surface.
2. Inspect relevant files, tests, conventions, and project instructions.
3. Ask the user about choices that materially change scope or architecture.
4. Divide the work into three to eight ordered tasks when practical.
5. Make every task usable without chat history or prior-iteration memory.
6. Give every task one objective, non-interactive verification command.
7. Select one broad final verification command.
8. Call `lean_finalize_plan` only when no blocking questions remain and the user
   wants to review the plan for approval.
9. When a draft is rejected, apply submitted refinement instructions narrowly
   and preserve unaffected tasks. If no instructions were submitted, stop and
   wait for the user's next message instead of guessing.
10. If the user explicitly asks to save or defer the plan, call
    `lean_save_plan` instead of the finalizer. This is the only planning write
    allowed without approval.

## Keep tasks executable

- Put foundational changes before their consumers.
- Name likely project-relative files.
- State behavior, constraints, and important edge cases explicitly.
- Keep one coherent outcome per task.
- Avoid “finish the feature,” “fix anything remaining,” and manual verification.
- Do not ask an iteration to coordinate agents, edit `RALPH.md`, or choose an
  unresolved design.
- The runner owns task selection, approved verification, independent validation,
  and PLAN.md checkbox updates. Do not put those coordination steps in task text.

The finalizer assigns stable task IDs, asks for human approval, and writes
`PLAN.md`, `OPEN_QUESTIONS.md`, acceptance scripts, and a native
lean pi-ralph-loop `RALPH.md`. It does not implement a loop or start one.

`lean_save_plan` writes a non-runnable `DRAFT.md` plus structured state under
`.pi/lean-drafts/`. In a later session, `/lean-plan-resume [path]` restores the
complete task details and returns to read-only planning. Saving a resumed
`DRAFT.md` updates it in place; saving after resuming an approved `PLAN.md`
creates a new draft. Replace every `false # TODO(lean-plan)` verification
placeholder before approval. Do not recreate a saved plan from memory when the
resume command can load it.

After approval, `/lean-plan-view [task folder or PLAN.md]` can deterministically
render the plan as a self-contained Tailwind HTML visualization. Use the command
when the user asks to see, share, or refresh a visual plan; do not spend a model
turn recreating the diagram manually.
