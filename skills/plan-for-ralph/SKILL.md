---
name: plan-for-ralph
description: Create an implementation plan for the Laguna plan runner by exploring a project read-only, resolving important questions, and submitting small sequential tasks with standalone instructions and executable verification commands. Use when the user asks to plan work for a Ralph-style loop, prepare work for a weaker or low-context model, or invokes /laguna-plan.
---

# Plan for Ralph

Explore the project before proposing tasks. Stay read-only throughout planning.

## Build the plan

1. Identify the requested outcome and the smallest affected project surface.
2. Inspect relevant local files, tests, conventions, and project instructions.
3. Ask the user about any decision that materially changes scope or architecture.
4. Divide the work into ordered tasks that one fresh worker can complete at a time.
5. Give each task enough context to work without this conversation or prior-worker memory.
6. Assign each task one non-interactive verification command with an objective exit status.
7. Choose one final verification command for the complete change.
8. Call `laguna_finalize_plan` only when no blocking questions remain.

## Keep tasks easy to execute

- Prefer three to eight tasks.
- Keep one coherent outcome per task.
- Name likely project-relative files, while allowing the worker to inspect nearby code.
- State exact behavior, constraints, and important edge cases in the instructions.
- Put foundational changes before their consumers.
- Avoid tasks such as “finish the feature,” “fix anything remaining,” or “verify everything.”
- Do not ask a worker to coordinate other agents, update plan files, or choose among unresolved designs.

## Verification rules

- Use commands already supported by the project.
- Keep commands non-interactive and scoped to the task when practical.
- Do not use a placeholder such as “manual testing.”
- Do not combine unrelated repair work into a verification command.
- Make the final command broad enough to catch integration failures.

The finalization tool assigns stable task IDs, adds sequential dependencies, asks
for explicit human approval, and writes `PLAN.md`, `RALPH.md`,
`OPEN_QUESTIONS.md`, and machine state. It does not start implementation.
