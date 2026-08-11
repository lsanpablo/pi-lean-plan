import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  extractPlanProgress,
  normalizePlan,
  renderDraftMarkdown,
  renderFinalVerificationScript,
  renderPlanCheckScript,
  renderPlanHtml,
  renderPlanMarkdown,
  renderRefinementRequest,
  renderResumeRequest,
  renderRalphMarkdown,
  slugify,
} from "../extensions/core.js";

function samplePlan() {
  return normalizePlan(
    {
      title: "Add guarded widget sync",
      objective: "Implement guarded synchronization and verify the complete behavior.",
      tasks: [
        {
          title: "Add the sync helper",
          instructions: "Implement the helper and focused tests.",
          files: ["src/sync.js", "tests/sync.test.js"],
          verification: "node --test tests/sync.test.js",
        },
        {
          title: "Wire the helper",
          instructions: "Call the helper from the existing update path.",
          files: ["src/index.js"],
          verification: "node --test",
        },
      ],
      final_verification: "npm test",
    },
    new Date("2026-07-29T12:00:00.000Z"),
  );
}

test("normalizes sequential tasks for a low-context planner", () => {
  const plan = samplePlan();
  assert.equal(plan.slug, "add-guarded-widget-sync");
  assert.equal(plan.maxIterations, 10);
  assert.deepEqual(
    plan.tasks.map(({ id, dependsOn }) => ({ id, dependsOn })),
    [
      { id: "T001", dependsOn: null },
      { id: "T002", dependsOn: "T001" },
    ],
  );
  assert.equal(slugify(" À risky / title! "), "a-risky-title");
});

test("rejects publish commands disguised as verification", () => {
  assert.throws(
    () =>
      normalizePlan({
        title: "Unsafe plan",
        objective: "Do not let acceptance commands publish.",
        tasks: [
          {
            title: "Publish",
            instructions: "Publish the package.",
            verification: "npm publish",
          },
        ],
        final_verification: "true",
      }),
    /may not contain npm publish/,
  );
});

test("renders an explicit checkbox plan", () => {
  const markdown = renderPlanMarkdown(samplePlan());
  assert.match(markdown, /- \[ \] \*\*T001 — Add the sync helper\*\*/);
  assert.match(markdown, /- \[ \] \*\*T002 — Wire the helper\*\*/);
  assert.match(markdown, /Verification evidence: _pending_/);
  assert.match(markdown, /node --test tests\/sync\.test\.js/);
});

test("renders an unapproved resumable Markdown draft", () => {
  const markdown = renderDraftMarkdown(samplePlan());
  assert.match(markdown, /^<!-- lean-plan-draft:v1 -->/);
  assert.match(markdown, /- Status: draft/);
  assert.match(markdown, /Execution: not approved/);
  assert.match(markdown, /## Proposed tasks/);
  assert.match(markdown, /## Proposed final verification/);
  assert.doesNotMatch(markdown, /- Status: approved/);
});

test("extracts live checkbox and verification evidence", () => {
  const plan = samplePlan();
  const markdown = renderPlanMarkdown(plan)
    .replace(
      "- [ ] **T001 — Add the sync helper**",
      "- [x] **T001 — Add the sync helper**",
    )
    .replace(
      "  - Verification evidence: _pending_",
      "  - Verification evidence: 12 focused tests passed",
    );
  const progress = extractPlanProgress(plan, markdown);
  assert.equal(progress.completeCount, 1);
  assert.equal(progress.totalCount, 2);
  assert.equal(progress.percentComplete, 50);
  assert.equal(progress.tasks[0].complete, true);
  assert.equal(progress.tasks[0].evidence, "12 focused tests passed");
  assert.equal(progress.tasks[1].complete, false);
});

test("renders a self-contained Tailwind plan visualization", () => {
  const plan = samplePlan();
  plan.title = "Guarded <widget> & sync";
  const markdown = renderPlanMarkdown(plan);
  const html = renderPlanHtml(
    plan,
    markdown,
    "/* compiled tailwind */ body{display:block}",
    new Date("2026-08-06T12:00:00.000Z"),
  );
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /\/\* compiled tailwind \*\//);
  assert.match(html, /Sequential task flow/);
  assert.match(html, /Required Ralph gate/);
  assert.match(html, /LEAN_PLAN_COMPLETE/);
  assert.match(html, /Guarded &lt;widget&gt; &amp; sync/);
  assert.doesNotMatch(html, /cdn\.jsdelivr|<script>/);
});

test("anchors refinement instructions to the rejected draft", () => {
  const request = renderRefinementRequest(
    samplePlan(),
    "Add a task for migration documentation and preserve the two existing tasks.",
  );
  assert.match(request, /\[LEAN PLAN REFINEMENT\]/);
  assert.match(request, /T001\. Add the sync helper/);
  assert.match(request, /T002\. Wire the helper/);
  assert.match(request, /Add a task for migration documentation/);
  assert.match(request, /Preserve unaffected decisions/);
  assert.match(request, /call lean_finalize_plan\s+again/);
});

test("rejects empty refinement feedback", () => {
  assert.throws(
    () => renderRefinementRequest(samplePlan(), "   "),
    /refinement feedback must be a non-empty string/,
  );
});

test("renders a complete low-context resume request", () => {
  const request = renderResumeRequest(
    samplePlan(),
    ".pi/lean-drafts/add-guarded-widget-sync/DRAFT.md",
  );
  assert.match(request, /\[LEAN PLAN RESUME\]/);
  assert.match(request, /\.pi\/lean-drafts\/add-guarded-widget-sync\/DRAFT\.md/);
  assert.match(request, /Implement the helper and focused tests/);
  assert.match(request, /lean_finalize_plan/);
  assert.match(request, /lean_save_plan/);
  assert.match(request, /do not\nimplement it/);
});

test("renders native pi-ralph-loop v2 configuration", () => {
  const markdown = renderRalphMarkdown(
    samplePlan(),
    ".pi/lean-plans/add-guarded-widget-sync",
  );
  assert.match(markdown, /^---\ncommands:/);
  assert.match(markdown, /name: plan-status[\s\S]*acceptance: true/);
  assert.match(markdown, /name: final-verification[\s\S]*acceptance: true/);
  assert.match(markdown, /items_per_iteration: 1/);
  assert.match(markdown, /completion_promise: 'LEAN_PLAN_COMPLETE'/);
  assert.match(markdown, /completion_gate: required/);
  assert.match(markdown, /stop_on_error: false/);
  assert.match(markdown, /policy:secret-bearing-paths/);
  assert.doesNotMatch(markdown, /spawn|child process|custom loop/i);
});

test("check-plan gate fails until tasks are checked in order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lean-plan-check-"));
  const plan = samplePlan();
  const planPath = path.join(root, "PLAN.md");
  const scriptPath = path.join(root, "check-plan.sh");
  await fs.writeFile(planPath, renderPlanMarkdown(plan));
  await fs.writeFile(scriptPath, renderPlanCheckScript(plan), { mode: 0o755 });

  let result = spawnSync(scriptPath, [], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /0\/2 tasks checked/);

  let markdown = await fs.readFile(planPath, "utf8");
  markdown = markdown.replace(
    "- [ ] **T002 — Wire the helper**",
    "- [x] **T002 — Wire the helper**",
  );
  await fs.writeFile(planPath, markdown);
  result = spawnSync(scriptPath, [], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /checked out of order/);

  markdown = markdown.replace(
    "- [ ] **T001 — Add the sync helper**",
    "- [x] **T001 — Add the sync helper**",
  );
  await fs.writeFile(planPath, markdown);
  result = spawnSync(scriptPath, [], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /2\/2 tasks checked/);
  await fs.rm(root, { recursive: true, force: true });
});

test("final verification wrapper runs from the project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lean-final-check-"));
  const taskDirectory = path.join(root, ".pi", "lean-plans", "test");
  await fs.mkdir(taskDirectory, { recursive: true });
  const plan = normalizePlan({
    title: "Check root",
    objective: "Prove the final command starts in the project root.",
    tasks: [
      {
        title: "Make change",
        instructions: "Make the requested change.",
        verification: "true",
      },
    ],
    final_verification:
      "printf \"%s\" \"it's fine\" > final-quote.txt && pwd > final-pwd.txt",
  });
  const scriptPath = path.join(taskDirectory, "run-final-verification.sh");
  await fs.writeFile(scriptPath, renderFinalVerificationScript(plan), { mode: 0o755 });

  const result = spawnSync(scriptPath, [], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(
    (await fs.readFile(path.join(root, "final-pwd.txt"), "utf8")).trim(),
    root,
  );
  assert.equal(
    await fs.readFile(path.join(root, "final-quote.txt"), "utf8"),
    "it's fine",
  );
  await fs.rm(root, { recursive: true, force: true });
});
