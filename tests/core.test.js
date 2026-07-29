import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PLAN_FILE,
  PLAN_STATE_FILE,
  RUN_STATE_FILE,
  markTaskComplete,
  normalizePlan,
  readChecklist,
  renderPlanMarkdown,
  setPlanStatus,
  slugify,
} from "../extensions/core.js";
import { executePlan, runPiWorker } from "../extensions/runner.js";

function samplePlan() {
  return normalizePlan(
    {
      title: "Add guarded widget sync",
      summary: "Add one small behavior and cover it with focused tests.",
      tasks: [
        {
          title: "Add the sync helper",
          instructions: "Implement the helper and its unit tests.",
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

test("normalizes ids and dependencies for a weak planner", () => {
  const plan = samplePlan();
  assert.equal(plan.slug, "add-guarded-widget-sync");
  assert.deepEqual(
    plan.tasks.map(({ id, dependsOn }) => ({ id, dependsOn })),
    [
      { id: "T001", dependsOn: null },
      { id: "T002", dependsOn: "T001" },
    ],
  );
  assert.equal(slugify(" À risky / title! "), "a-risky-title");
});

test("renders and updates only controller-owned checkboxes", () => {
  const plan = samplePlan();
  let markdown = renderPlanMarkdown(plan);
  assert.deepEqual([...readChecklist(markdown, plan)], []);
  markdown = setPlanStatus(markdown, "running");
  markdown = markTaskComplete(markdown, "T001", "focused test passed");
  assert.deepEqual([...readChecklist(markdown, plan)], ["T001"]);
  assert.match(markdown, /- Evidence: focused test passed/);
  assert.match(markdown, /- Status: running/);
});

test("runs one fresh worker per task and checks boxes after controller verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "laguna-runner-"));
  const planDir = path.join(root, ".pi", "plans", "test");
  await fs.mkdir(planDir, { recursive: true });
  const plan = samplePlan();
  await fs.writeFile(path.join(planDir, PLAN_STATE_FILE), `${JSON.stringify(plan)}\n`);
  await fs.writeFile(path.join(planDir, PLAN_FILE), renderPlanMarkdown(plan));

  const workerCalls = [];
  const verificationCalls = [];
  const result = await executePlan({
    projectCwd: root,
    planDir,
    modelSelector: "poolside/laguna-m",
    runWorker: async ({ task }) => {
      workerCalls.push(task.id);
      return { code: 0 };
    },
    runVerification: async ({ command }) => {
      verificationCalls.push(command);
      return { code: 0 };
    },
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(workerCalls, ["T001", "T002"]);
  assert.deepEqual(verificationCalls, [
    "node --test tests/sync.test.js",
    "node --test",
    "npm test",
  ]);
  const markdown = await fs.readFile(path.join(planDir, PLAN_FILE), "utf8");
  assert.deepEqual([...readChecklist(markdown, plan)], ["T001", "T002"]);
  assert.match(markdown, /- Status: complete/);
  const runState = JSON.parse(await fs.readFile(path.join(planDir, RUN_STATE_FILE), "utf8"));
  assert.equal(runState.status, "complete");
  await fs.rm(root, { recursive: true, force: true });
});

test("retries a failed verification with a fresh worker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "laguna-retry-"));
  const planDir = path.join(root, ".pi", "plans", "test");
  await fs.mkdir(planDir, { recursive: true });
  const plan = normalizePlan({
    title: "Retry one task",
    summary: "Exercise retry behavior.",
    tasks: [
      {
        title: "Implement",
        instructions: "Implement the requested behavior.",
        verification: "npm test",
      },
    ],
    final_verification: "npm test",
  });
  await fs.writeFile(path.join(planDir, PLAN_STATE_FILE), `${JSON.stringify(plan)}\n`);
  await fs.writeFile(path.join(planDir, PLAN_FILE), renderPlanMarkdown(plan));

  let workers = 0;
  let verifications = 0;
  const result = await executePlan({
    projectCwd: root,
    planDir,
    runWorker: async () => {
      workers += 1;
      return { code: 0 };
    },
    runVerification: async () => {
      verifications += 1;
      return { code: verifications === 1 ? 1 : 0 };
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(workers, 2);
  assert.equal(verifications, 3);
  await fs.rm(root, { recursive: true, force: true });
});

test("restores PLAN.md when a worker tampers with it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "laguna-protect-"));
  const planDir = path.join(root, ".pi", "plans", "test");
  await fs.mkdir(planDir, { recursive: true });
  const plan = normalizePlan({
    title: "Protect state",
    summary: "Keep workers away from controller state.",
    tasks: [
      {
        title: "Try worker",
        instructions: "Make the implementation change.",
        verification: "true",
      },
    ],
    final_verification: "true",
  });
  await fs.writeFile(path.join(planDir, PLAN_STATE_FILE), `${JSON.stringify(plan)}\n`);
  await fs.writeFile(path.join(planDir, PLAN_FILE), renderPlanMarkdown(plan));

  await executePlan({
    projectCwd: root,
    planDir,
    runWorker: async () => {
      const changed = markTaskComplete(
        await fs.readFile(path.join(planDir, PLAN_FILE), "utf8"),
        "T001",
        "worker claimed success",
      );
      await fs.writeFile(path.join(planDir, PLAN_FILE), changed);
      return { code: 0 };
    },
    runVerification: async () => ({ code: 0 }),
  });

  const markdown = await fs.readFile(path.join(planDir, PLAN_FILE), "utf8");
  assert.doesNotMatch(markdown, /worker claimed success/);
  assert.match(markdown, /controller ran `true` successfully/);
  await fs.rm(root, { recursive: true, force: true });
});

test("spawns a Pi-compatible child with isolated context and the selected model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "laguna-child-"));
  const mockPi = path.join(root, "mock-pi.mjs");
  const logPath = path.join(root, "child.jsonl");
  await fs.writeFile(
    mockPi,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");
});
`,
  );
  await fs.chmod(mockPi, 0o755);
  const plan = samplePlan();
  const result = await runPiWorker({
    plan,
    task: plan.tasks[0],
    projectCwd: root,
    logPath,
    modelSelector: "poolside/laguna-m",
    thinkingLevel: "medium",
    piExecutable: mockPi,
  });

  assert.equal(result.code, 0);
  const record = JSON.parse((await fs.readFile(logPath, "utf8")).trim());
  assert.deepEqual(record.args.slice(0, 6), [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
  ]);
  assert.ok(record.args.includes("poolside/laguna-m"));
  assert.match(record.input, /Complete exactly one task/);
  assert.match(record.input, /Never edit anything under \.pi\/plans\//);
  await fs.rm(root, { recursive: true, force: true });
});
