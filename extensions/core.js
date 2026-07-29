import path from "node:path";

export const PLAN_FILE = "PLAN.md";
export const RALPH_FILE = "RALPH.md";
export const QUESTIONS_FILE = "OPEN_QUESTIONS.md";
export const PLAN_STATE_FILE = ".lean-plan.json";
export const PLAN_CHECK_FILE = "check-plan.sh";
export const FINAL_CHECK_FILE = "run-final-verification.sh";

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireVerificationCommand(value, label) {
  const command = requireText(value, label);
  const blocked = [
    { pattern: /\bgit\s+push\b/i, label: "git push" },
    { pattern: /\bnpm\s+publish\b/i, label: "npm publish" },
    { pattern: /\brm\s+-rf\s+\/(?:\s|$)/i, label: "rm -rf /" },
  ];
  const match = blocked.find(({ pattern }) => pattern.test(command));
  if (match) {
    throw new Error(`${label} may not contain ${match.label}`);
  }
  return command;
}

export function slugify(value) {
  const slug = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "plan";
}

export function normalizePlan(input, now = new Date()) {
  if (!input || typeof input !== "object") {
    throw new Error("Plan input must be an object");
  }

  const title = requireText(input.title, "title");
  const objective = requireText(input.objective, "objective");
  const finalVerification = requireText(
    input.final_verification ?? input.finalVerification,
    "final_verification",
  );

  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 12) {
    throw new Error("tasks must contain between 1 and 12 items");
  }

  const tasks = input.tasks.map((task, index) => {
    if (!task || typeof task !== "object") {
      throw new Error(`tasks[${index}] must be an object`);
    }
    const files = task.files ?? [];
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
      throw new Error(`tasks[${index}].files must be an array of strings`);
    }

    return {
      id: `T${String(index + 1).padStart(3, "0")}`,
      title: requireText(task.title, `tasks[${index}].title`),
      instructions: requireText(task.instructions, `tasks[${index}].instructions`),
      files: files.map((file) => file.trim()).filter(Boolean),
      verification: requireVerificationCommand(
        task.verification,
        `tasks[${index}].verification`,
      ),
      dependsOn: index === 0 ? null : `T${String(index).padStart(3, "0")}`,
    };
  });

  return {
    version: 1,
    title,
    slug: slugify(title),
    objective,
    createdAt: now.toISOString(),
    finalVerification: requireVerificationCommand(
      finalVerification,
      "final_verification",
    ),
    maxIterations: Math.min(50, Math.max(10, tasks.length * 3 + 2)),
    timeoutSeconds: 900,
    tasks,
  };
}

export function validatePlan(plan) {
  if (!plan || plan.version !== 1) throw new Error("Unsupported plan version");
  requireText(plan.title, "plan.title");
  requireText(plan.objective, "plan.objective");
  requireText(plan.finalVerification, "plan.finalVerification");
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > 12) {
    throw new Error("Plan must contain between 1 and 12 tasks");
  }
  for (const [index, task] of plan.tasks.entries()) {
    const id = `T${String(index + 1).padStart(3, "0")}`;
    const dependency = index === 0 ? null : `T${String(index).padStart(3, "0")}`;
    if (task.id !== id) throw new Error(`Invalid task id at index ${index}`);
    if ((task.dependsOn ?? null) !== dependency) {
      throw new Error(`${id} has an invalid sequential dependency`);
    }
    requireText(task.title, `${id}.title`);
    requireText(task.instructions, `${id}.instructions`);
    requireText(task.verification, `${id}.verification`);
  }
  return plan;
}

function shellFence(command) {
  return `\`\`\`sh\n${command}\n\`\`\``;
}

export function renderPlanMarkdown(plan) {
  validatePlan(plan);
  const tasks = plan.tasks
    .map((task) => {
      const files =
        task.files.length > 0
          ? task.files.map((file) => `\`${file}\``).join(", ")
          : "Discover the relevant local files";
      return `<!-- lean-task:start:${task.id} -->
- [ ] **${task.id} — ${task.title}**
  - Depends on: ${task.dependsOn ?? "none"}
  - Likely files: ${files}
  - Verification evidence: _pending_

  ${task.instructions}

  Run before checking this task:

${shellFence(task.verification)}
<!-- lean-task:end:${task.id} -->`;
    })
    .join("\n\n");

  return `<!-- lean-plan:v1 -->
# ${plan.title}

- Status: approved
- Created: ${plan.createdAt}
- Execution: first unchecked task only; one task per Ralph iteration

## Objective

${plan.objective}

## Checklist contract

1. Work only on the first unchecked task.
2. Inspect the project before editing.
3. Run that task's verification command after implementation.
4. If verification fails, leave the task unchecked.
5. If verification succeeds, change only its checkbox to \`[x]\` and replace
   \`Verification evidence: _pending_\` with a concise result.
6. Do not start a later task in the same iteration.

## Tasks

${tasks}

## Final verification

${shellFence(plan.finalVerification)}
`;
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function renderRalphMarkdown(plan, taskDirectory) {
  validatePlan(plan);
  const planPath = path.posix.join(taskDirectory.replaceAll("\\", "/"), PLAN_FILE);
  const questionsPath = path.posix.join(
    taskDirectory.replaceAll("\\", "/"),
    QUESTIONS_FILE,
  );

  return `---
commands:
  - name: plan-status
    run: './${PLAN_CHECK_FILE}'
    timeout: 20
    acceptance: true
  - name: final-verification
    run: './${FINAL_CHECK_FILE}'
    timeout: ${plan.timeoutSeconds}
    acceptance: true
max_iterations: ${plan.maxIterations}
inter_iteration_delay: 0
items_per_iteration: 1
timeout: ${plan.timeoutSeconds}
completion_promise: ${yamlQuote("LEAN_PLAN_COMPLETE")}
completion_gate: required
required_outputs:
  - ${yamlQuote(PLAN_FILE)}
  - ${yamlQuote(QUESTIONS_FILE)}
stop_on_error: false
guardrails:
  block_commands:
    - ${yamlQuote("git\\s+push")}
    - ${yamlQuote("npm\\s+publish")}
    - ${yamlQuote("rm\\s+-rf\\s+/(?:\\s|$)")}
  protected_files:
    - ${yamlQuote("policy:secret-bearing-paths")}
    - ${yamlQuote(RALPH_FILE)}
    - ${yamlQuote(PLAN_STATE_FILE)}
    - ${yamlQuote(PLAN_CHECK_FILE)}
    - ${yamlQuote(FINAL_CHECK_FILE)}
---

# Execute the approved plan

You are running inside \`@lnilluv/pi-ralph-loop\`. Each iteration has fresh
context. The approved plan and its checkboxes are durable state.

## Objective

${plan.objective}

## Current evidence

Checklist gate:

{{ commands.plan-status }}

Final verification:

{{ commands.final-verification }}

These command results were collected before this iteration. Ralph reruns both
commands after the completion promise because they are acceptance commands.

## Iteration procedure

1. Read \`${planPath}\`.
2. Select only the first unchecked task.
3. Inspect the relevant project files and existing conventions.
4. Implement that task completely.
5. Run the task-specific verification command from \`PLAN.md\`.
6. Check off the task and record evidence only if that command succeeds.
7. Stop the iteration without beginning another task.

If implementation exposes a blocking product or architecture decision, record it
under a P0 or P1 heading in \`${questionsPath}\`, leave the task unchecked, and
explain the blocker. Mark resolved questions as checked items or remove them.

Do not edit \`${RALPH_FILE}\`, \`${PLAN_STATE_FILE}\`, \`${PLAN_CHECK_FILE}\`, or
\`${FINAL_CHECK_FILE}\`. Do not push or publish.

## Completion

Emit <promise>LEAN_PLAN_COMPLETE</promise> only when:

- every task in \`${planPath}\` is checked;
- \`${questionsPath}\` has no unresolved P0/P1 items;
- the final verification succeeds.

The Ralph completion gate is authoritative. If any acceptance check fails after
the promise, continue working on the first remaining failure.
`;
}

export function renderOpenQuestionsMarkdown() {
  return `# Open Questions

No unresolved priority questions.

If a loop iteration discovers a blocker, add it as an unchecked item beneath a
\`## P0\` or \`## P1\` heading. Check or remove it after resolution.
`;
}

export function renderPlanCheckScript(plan) {
  validatePlan(plan);
  const expectedIds = plan.tasks.map((task) => task.id).join(" ");
  return `#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plan_file="$script_dir/${PLAN_FILE}"

if [ ! -f "$plan_file" ]; then
  echo "PLAN.md is missing" >&2
  exit 2
fi

actual_ids=$(sed -n 's/^- \\[[ xX]\\] \\*\\*\\(T[0-9][0-9][0-9]\\) .*/\\1/p' "$plan_file" | paste -sd ' ' -)
expected_ids=${shellQuote(expectedIds)}

if [ "$actual_ids" != "$expected_ids" ]; then
  echo "PLAN.md task structure changed unexpectedly" >&2
  echo "expected: $expected_ids" >&2
  echo "actual:   $actual_ids" >&2
  exit 2
fi

if ! awk '
  /^- \\[ \\] \\*\\*T[0-9][0-9][0-9] / { saw_unchecked = 1; next }
  /^- \\[[xX]\\] \\*\\*T[0-9][0-9][0-9] / {
    if (saw_unchecked) invalid = 1
  }
  END { exit invalid ? 1 : 0 }
' "$plan_file"; then
  echo "PLAN.md tasks were checked out of order" >&2
  exit 2
fi

checked=$(awk '/^- \\[[xX]\\] \\*\\*T[0-9][0-9][0-9] / { count++ } END { print count + 0 }' "$plan_file")
unchecked=$(awk '/^- \\[ \\] \\*\\*T[0-9][0-9][0-9] / { count++ } END { print count + 0 }' "$plan_file")
total=$((checked + unchecked))

echo "Lean plan: $checked/$total tasks checked"
if [ "$unchecked" -gt 0 ]; then
  echo "Remaining:"
  awk '/^- \\[ \\] \\*\\*T[0-9][0-9][0-9] / { print "  " $0 }' "$plan_file"
  exit 1
fi

echo "All plan tasks are checked."
`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function renderFinalVerificationScript(plan) {
  validatePlan(plan);
  return `#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
cd "$project_dir"

exec /bin/sh -lc ${shellQuote(plan.finalVerification)}
`;
}

export function renderApprovalPreview(plan) {
  validatePlan(plan);
  const tasks = plan.tasks
    .map(
      (task) =>
        `${task.id}. ${task.title}\n   Verify: ${task.verification}`,
    )
    .join("\n");
  return `${plan.title}

${plan.objective}

${tasks}

Ralph final acceptance: ${plan.finalVerification}
Maximum Ralph iterations: ${plan.maxIterations}

Approve writing this plan? This does not start Ralph yet.`;
}

export function assertPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.resolve(candidate);
  }
  throw new Error(`Path must stay inside ${path.resolve(parent)}`);
}
