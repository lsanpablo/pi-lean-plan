import path from "node:path";

export const PLAN_STATE_FILE = ".laguna-plan.json";
export const RUN_STATE_FILE = ".laguna-run.json";
export const PLAN_FILE = "PLAN.md";
export const RALPH_FILE = "RALPH.md";
export const QUESTIONS_FILE = "OPEN_QUESTIONS.md";

const TASK_ID_PATTERN = /^T\d{3}$/;

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
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
  const summary = requireText(input.summary, "summary");
  const finalVerification = requireText(
    input.final_verification ?? input.finalVerification,
    "final_verification",
  );

  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 30) {
    throw new Error("tasks must contain between 1 and 30 items");
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
      verification: requireText(
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
    summary,
    createdAt: now.toISOString(),
    status: "ready",
    finalVerification,
    maxAttemptsPerTask: 2,
    taskTimeoutSeconds: 900,
    tasks,
  };
}

function fencedShell(command) {
  return `\`\`\`sh\n${command}\n\`\`\``;
}

export function renderPlanMarkdown(plan) {
  validatePlanState(plan);
  const taskSections = plan.tasks
    .map((task) => {
      const files = task.files.length > 0 ? task.files.map((file) => `\`${file}\``).join(", ") : "Not preselected";
      return `<!-- laguna-task:start:${task.id} -->
## ${task.id} — ${task.title}

- [ ] Status
- Depends on: ${task.dependsOn ?? "none"}
- Files: ${files}
- Verify:

${fencedShell(task.verification)}

### Instructions

${task.instructions}
<!-- laguna-task:end:${task.id} -->`;
    })
    .join("\n\n");

  return `<!-- laguna-plan:v1 -->
# ${plan.title}

- Status: ready
- Created: ${plan.createdAt}
- Execution: sequential, one fresh Pi process per task
- Checkboxes: controller-owned; workers must not edit this file

## Summary

${plan.summary}

## Tasks

${taskSections}

## Final verification

${fencedShell(plan.finalVerification)}
`;
}

export function renderRalphMarkdown(plan) {
  validatePlanState(plan);
  return `---
name: ${plan.slug}
plan: PLAN.md
max_iterations: ${Math.min(50, plan.tasks.length * plan.maxAttemptsPerTask + 1)}
items_per_iteration: 1
completion_promise: LAGUNA_PLAN_COMPLETE
---

# Worker contract

Read \`PLAN.md\` and work on only the first unchecked task.

1. Inspect the local project before editing.
2. Implement only that task and its necessary supporting changes.
3. Run the task's verification command.
4. Do not edit \`PLAN.md\`, \`RALPH.md\`, \`OPEN_QUESTIONS.md\`, or hidden state files in this directory.
5. Stop after the one task. The deterministic controller owns retries, verification, and checkboxes.

When every task is checked and the final verification succeeds, the controller records
\`LAGUNA_PLAN_COMPLETE\`.
`;
}

export function renderOpenQuestionsMarkdown(plan) {
  validatePlanState(plan);
  return `# Open Questions

None. This plan was explicitly approved before these files were written.

If implementation discovers a decision that changes scope or architecture, stop the
runner and return to planning instead of guessing.
`;
}

export function renderApprovalPreview(plan) {
  validatePlanState(plan);
  const tasks = plan.tasks
    .map(
      (task) =>
        `${task.id}. ${task.title}\n   Verify: ${task.verification}`,
    )
    .join("\n");
  return `${plan.title}

${plan.summary}

${tasks}

Final verification: ${plan.finalVerification}

Approve writing this plan? No implementation will start yet.`;
}

export function validatePlanState(plan) {
  if (!plan || plan.version !== 1) {
    throw new Error("Unsupported or missing plan version");
  }
  requireText(plan.title, "plan.title");
  requireText(plan.summary, "plan.summary");
  requireText(plan.finalVerification, "plan.finalVerification");
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1) {
    throw new Error("Plan has no tasks");
  }
  for (const [index, task] of plan.tasks.entries()) {
    if (!TASK_ID_PATTERN.test(task.id) || task.id !== `T${String(index + 1).padStart(3, "0")}`) {
      throw new Error(`Invalid sequential task id at index ${index}`);
    }
    requireText(task.title, `${task.id}.title`);
    requireText(task.instructions, `${task.id}.instructions`);
    requireText(task.verification, `${task.id}.verification`);
    const expectedDependency = index === 0 ? null : `T${String(index).padStart(3, "0")}`;
    if ((task.dependsOn ?? null) !== expectedDependency) {
      throw new Error(`${task.id} has an invalid dependency`);
    }
  }
  return plan;
}

export function readChecklist(markdown, plan) {
  validatePlanState(plan);
  const completed = new Set();
  for (const task of plan.tasks) {
    const blockPattern = new RegExp(
      `<!-- laguna-task:start:${task.id} -->([\\s\\S]*?)<!-- laguna-task:end:${task.id} -->`,
    );
    const match = markdown.match(blockPattern);
    if (!match) {
      throw new Error(`PLAN.md is missing the ${task.id} task block`);
    }
    const statusMatch = match[1].match(/^- \[([ xX])\] Status$/m);
    if (!statusMatch) {
      throw new Error(`PLAN.md has no controller checkbox for ${task.id}`);
    }
    if (statusMatch[1].toLowerCase() === "x") completed.add(task.id);
  }
  return completed;
}

export function markTaskComplete(markdown, taskId, evidence) {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const blockPattern = new RegExp(
    `(<!-- laguna-task:start:${taskId} -->)([\\s\\S]*?)(<!-- laguna-task:end:${taskId} -->)`,
  );
  const match = markdown.match(blockPattern);
  if (!match) throw new Error(`PLAN.md is missing the ${taskId} task block`);
  if (!/^- \[ \] Status$/m.test(match[2])) {
    if (/^- \[[xX]\] Status$/m.test(match[2])) return markdown;
    throw new Error(`PLAN.md has an invalid checkbox for ${taskId}`);
  }

  const safeEvidence = String(evidence).replace(/\s+/g, " ").trim();
  const updatedBlock = match[2]
    .replace(/^- \[ \] Status$/m, "- [x] Status")
    .replace(
      /^- \[x\] Status$/m,
      `- [x] Status\n- Evidence: ${safeEvidence}`,
    );
  return markdown.replace(blockPattern, `$1${updatedBlock}$3`);
}

export function setPlanStatus(markdown, status) {
  const allowed = new Set(["ready", "running", "failed", "stopped", "complete"]);
  if (!allowed.has(status)) throw new Error(`Invalid plan status: ${status}`);
  if (!/^- Status: (ready|running|failed|stopped|complete)$/m.test(markdown)) {
    throw new Error("PLAN.md has no valid plan status");
  }
  return markdown.replace(
    /^- Status: (ready|running|failed|stopped|complete)$/m,
    `- Status: ${status}`,
  );
}

export function assertPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.resolve(candidate);
  }
  throw new Error(`Path must stay inside ${path.resolve(parent)}`);
}

export function formatModelSelector(model) {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
    return null;
  }
  return `${model.provider}/${model.id}`;
}
