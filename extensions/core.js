import path from "node:path";

export const PLAN_FILE = "PLAN.md";
export const PLAN_HTML_FILE = "PLAN.html";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function taskBlock(markdown, taskId) {
  const startMarker = `<!-- lean-task:start:${taskId} -->`;
  const endMarker = `<!-- lean-task:end:${taskId} -->`;
  const start = markdown.indexOf(startMarker);
  if (start < 0) return "";
  const end = markdown.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return markdown.slice(start + startMarker.length, end);
}

export function extractPlanProgress(plan, markdown) {
  validatePlan(plan);
  if (typeof markdown !== "string") {
    throw new Error("PLAN.md content must be a string");
  }

  const tasks = plan.tasks.map((task) => {
    const block = taskBlock(markdown, task.id);
    const checkbox = block.match(
      new RegExp(`^- \\[([ xX])\\] \\*\\*${task.id}\\b`, "m"),
    );
    const evidenceMatch = block.match(/^\s*- Verification evidence:\s*(.+)$/m);
    const rawEvidence = evidenceMatch?.[1]?.trim() ?? "";
    return {
      id: task.id,
      complete: checkbox ? checkbox[1].toLowerCase() === "x" : false,
      evidence:
        rawEvidence && rawEvidence !== "_pending_" ? rawEvidence : null,
      structureFound: Boolean(block && checkbox),
    };
  });
  const completeCount = tasks.filter((task) => task.complete).length;
  const totalCount = tasks.length;
  return {
    tasks,
    completeCount,
    totalCount,
    percentComplete: Math.round((completeCount / totalCount) * 100),
  };
}

function renderDiagramArrow() {
  return `<div class="flex shrink-0 items-center justify-center px-1 text-slate-600" aria-hidden="true">
  <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-5-5 5 5-5 5" />
  </svg>
</div>`;
}

function renderFlowTask(task, state, isCurrent) {
  let containerClasses =
    "border-slate-700/80 bg-slate-900/80 text-slate-300";
  let badgeClasses = "bg-slate-800 text-slate-400 ring-slate-700";
  let status = "Queued";
  if (state.complete) {
    containerClasses =
      "border-emerald-400/40 bg-emerald-400/10 text-emerald-100";
    badgeClasses = "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30";
    status = "Complete";
  } else if (isCurrent) {
    containerClasses =
      "border-amber-300/50 bg-amber-300/10 text-amber-50 shadow-amber-950/30";
    badgeClasses = "bg-amber-300/15 text-amber-200 ring-amber-300/30";
    status = "Next";
  }
  return `<article class="w-64 shrink-0 rounded-2xl border p-4 shadow-xl ${containerClasses}">
  <div class="flex items-center justify-between gap-3">
    <span class="font-mono text-xs tracking-widest text-slate-400">${escapeHtml(task.id)}</span>
    <span class="rounded-full px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wider ring-1 ring-inset ${badgeClasses}">${status}</span>
  </div>
  <h3 class="mt-3 text-sm font-semibold leading-5">${escapeHtml(task.title)}</h3>
</article>`;
}

function renderTaskCard(task, state, index) {
  const statusClasses = state.complete
    ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
    : "bg-slate-800 text-slate-300 ring-slate-700";
  const status = state.complete ? "Complete" : "Pending";
  const files = task.files.length
    ? task.files
        .map(
          (file) =>
            `<code class="rounded-md bg-slate-950/80 px-2 py-1 text-xs text-cyan-200 ring-1 ring-slate-800">${escapeHtml(file)}</code>`,
        )
        .join("\n")
    : '<span class="text-sm text-slate-500">Discover relevant files locally</span>';
  const evidence = state.evidence
    ? `<p class="mt-2 text-sm text-emerald-200">${escapeHtml(state.evidence)}</p>`
    : '<p class="mt-2 text-sm text-slate-500">Pending successful verification</p>';

  return `<article class="group rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30 transition hover:border-slate-700">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <p class="font-mono text-xs uppercase tracking-[0.2em] text-indigo-300">Task ${String(index + 1).padStart(2, "0")} · ${escapeHtml(task.id)}</p>
      <h3 class="mt-2 text-xl font-semibold text-white">${escapeHtml(task.title)}</h3>
    </div>
    <span class="rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider ring-1 ring-inset ${statusClasses}">${status}</span>
  </div>
  <p class="mt-5 whitespace-pre-line text-sm leading-6 text-slate-300">${escapeHtml(task.instructions)}</p>
  <div class="mt-6">
    <h4 class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Likely files</h4>
    <div class="mt-3 flex flex-wrap gap-2">${files}</div>
  </div>
  <div class="mt-6 rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
    <div class="flex items-center justify-between gap-3">
      <h4 class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Verification</h4>
      <span class="text-xs text-slate-600">depends on ${escapeHtml(task.dependsOn ?? "none")}</span>
    </div>
    <pre class="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-5 text-cyan-200"><code>${escapeHtml(task.verification)}</code></pre>
    ${evidence}
  </div>
</article>`;
}

export function renderPlanHtml(
  plan,
  planMarkdown,
  tailwindCss,
  generatedAt = new Date(),
) {
  validatePlan(plan);
  if (typeof tailwindCss !== "string" || tailwindCss.trim() === "") {
    throw new Error("Compiled Tailwind CSS must be provided");
  }
  const progress = extractPlanProgress(plan, planMarkdown);
  const firstPending = progress.tasks.findIndex((task) => !task.complete);
  const flow = plan.tasks
    .flatMap((task, index) => [
      index > 0 ? renderDiagramArrow() : "",
      renderFlowTask(task, progress.tasks[index], index === firstPending),
    ])
    .join("\n");
  const cards = plan.tasks
    .map((task, index) => renderTaskCard(task, progress.tasks[index], index))
    .join("\n");
  const createdAt = new Date(plan.createdAt);
  const safeCreatedAt = Number.isNaN(createdAt.getTime())
    ? escapeHtml(plan.createdAt)
    : escapeHtml(createdAt.toLocaleString());
  const generatedIso = generatedAt.toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(plan.title)} · Lean Plan</title>
  <style>${tailwindCss}</style>
  <style>
    @media print {
      body { background: white !important; color: #0f172a !important; }
      .no-print { display: none !important; }
      article, section { break-inside: avoid; }
    }
  </style>
</head>
<body class="min-h-screen bg-[#050914] text-slate-200 antialiased selection:bg-indigo-400/30">
  <div class="pointer-events-none fixed inset-0 -z-10 overflow-hidden no-print" aria-hidden="true">
    <div class="absolute left-1/2 top-0 h-[32rem] w-[70rem] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-3xl"></div>
    <div class="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-cyan-400/5 blur-3xl"></div>
  </div>

  <main class="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:px-10 lg:py-16">
    <header class="rounded-[2rem] border border-slate-800 bg-slate-950/75 p-7 shadow-2xl shadow-indigo-950/20 backdrop-blur sm:p-10">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <span class="rounded-full bg-indigo-400/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300 ring-1 ring-indigo-400/30">Lean Plan</span>
          <span class="text-xs text-slate-500">Created ${safeCreatedAt}</span>
        </div>
        <span class="font-mono text-xs text-slate-600">v${escapeHtml(plan.version)}</span>
      </div>
      <h1 class="mt-7 max-w-4xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">${escapeHtml(plan.title)}</h1>
      <p class="mt-5 max-w-4xl whitespace-pre-line text-base leading-7 text-slate-300 sm:text-lg">${escapeHtml(plan.objective)}</p>

      <div class="mt-9 grid gap-4 sm:grid-cols-3">
        <div class="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Progress</p>
          <p class="mt-2 text-3xl font-semibold text-white">${progress.completeCount}<span class="text-lg text-slate-500">/${progress.totalCount}</span></p>
          <div class="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
            <div class="h-full rounded-full bg-linear-to-r from-indigo-400 to-cyan-300" style="width: ${progress.percentComplete}%"></div>
          </div>
        </div>
        <div class="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Execution</p>
          <p class="mt-2 text-3xl font-semibold text-white">1</p>
          <p class="mt-2 text-sm text-slate-400">task per fresh Ralph iteration</p>
        </div>
        <div class="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Iteration limit</p>
          <p class="mt-2 text-3xl font-semibold text-white">${escapeHtml(plan.maxIterations)}</p>
          <p class="mt-2 text-sm text-slate-400">with required completion gating</p>
        </div>
      </div>
    </header>

    <section class="mt-10 rounded-[2rem] border border-slate-800 bg-slate-950/60 p-6 sm:p-8" aria-labelledby="flow-title">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Execution diagram</p>
          <h2 id="flow-title" class="mt-2 text-2xl font-semibold text-white">Sequential task flow</h2>
        </div>
        <p class="text-sm text-slate-500">Scroll horizontally to inspect the complete chain</p>
      </div>
      <div class="mt-7 overflow-x-auto pb-3">
        <div class="flex min-w-max items-stretch">${flow}${renderDiagramArrow()}
          <article class="flex w-64 shrink-0 flex-col justify-center rounded-2xl border border-indigo-400/40 bg-indigo-400/10 p-4 text-indigo-100 shadow-xl">
            <span class="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Acceptance gate</span>
            <h3 class="mt-3 text-sm font-semibold">Verify every completion condition</h3>
          </article>
        </div>
      </div>
    </section>

    <section class="mt-10" aria-labelledby="tasks-title">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Work breakdown</p>
        <h2 id="tasks-title" class="mt-2 text-2xl font-semibold text-white">Plan tasks</h2>
      </div>
      <div class="mt-6 grid gap-6 lg:grid-cols-2">${cards}</div>
    </section>

    <section class="mt-10 rounded-[2rem] border border-indigo-400/25 bg-indigo-400/5 p-6 sm:p-8" aria-labelledby="gate-title">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Completion diagram</p>
      <h2 id="gate-title" class="mt-2 text-2xl font-semibold text-white">Required Ralph gate</h2>
      <div class="mt-7 flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        <div class="flex-1 rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
          <p class="font-mono text-xs text-emerald-300">01 · CHECKLIST</p>
          <p class="mt-2 font-semibold text-white">Every task checked in order</p>
        </div>
        ${renderDiagramArrow()}
        <div class="flex-1 rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
          <p class="font-mono text-xs text-emerald-300">02 · QUESTIONS</p>
          <p class="mt-2 font-semibold text-white">No unresolved P0 or P1 items</p>
        </div>
        ${renderDiagramArrow()}
        <div class="flex-1 rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
          <p class="font-mono text-xs text-emerald-300">03 · VERIFY</p>
          <p class="mt-2 font-semibold text-white">Final command exits successfully</p>
        </div>
        ${renderDiagramArrow()}
        <div class="flex-1 rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-5">
          <p class="font-mono text-xs text-emerald-300">DONE</p>
          <p class="mt-2 font-semibold text-emerald-50">LEAN_PLAN_COMPLETE</p>
        </div>
      </div>
      <div class="mt-7 rounded-2xl border border-slate-800 bg-slate-950/80 p-5">
        <h3 class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Final verification</h3>
        <pre class="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-sm leading-6 text-cyan-200"><code>${escapeHtml(plan.finalVerification)}</code></pre>
      </div>
    </section>

    <footer class="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-6 text-xs text-slate-600">
      <p>Generated deterministically from <code>PLAN.md</code> and <code>.lean-plan.json</code>.</p>
      <time datetime="${escapeHtml(generatedIso)}">Rendered ${escapeHtml(generatedAt.toLocaleString())}</time>
    </footer>
  </main>
</body>
</html>
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

export function renderRefinementRequest(plan, feedback) {
  validatePlan(plan);
  const requestedChanges = requireText(feedback, "refinement feedback");
  return `[LEAN PLAN REFINEMENT]

The user did not approve the current draft. Preserve unaffected decisions and
revise only what is needed to satisfy the explicit feedback.

Current draft:

${renderApprovalPreview(plan)}

User-requested changes:

${requestedChanges}

Do not implement. Update the structured plan, then call lean_finalize_plan
again so the user can review the revised draft.`;
}

export function assertPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.resolve(candidate);
  }
  throw new Error(`Path must stay inside ${path.resolve(parent)}`);
}
