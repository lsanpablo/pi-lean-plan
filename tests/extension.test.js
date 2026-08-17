import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import leanPlanExtension from "../extensions/index.js";

function createHarness() {
  const commands = new Map();
  const tools = new Map();
  const hooks = new Map();
  const messages = [];
  const notifications = [];
  let activeTools = ["read", "write", "bash"];

  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(nextTools) {
      activeTools = [...nextTools];
    },
    getCommands() {
      return [...commands.entries()].map(([name, command]) => ({
        name,
        source: "extension",
        ...command,
      }));
    },
    sendUserMessage(message) {
      messages.push(message);
    },
  };

  const context = (cwd) => ({
    cwd,
    hasUI: true,
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus() {},
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });

  return {
    pi,
    commands,
    tools,
    hooks,
    messages,
    notifications,
    context,
    activeTools: () => [...activeTools],
  };
}

function sampleInput() {
  return {
    title: "Save a widget plan",
    objective: "Persist a plan without making it executable.",
    tasks: [
      {
        title: "Add widget storage",
        instructions: "Implement widget storage and focused tests.",
        files: ["src/widgets.js", "tests/widgets.test.js"],
        verification: "node --test tests/widgets.test.js",
      },
    ],
    final_verification: "npm test",
  };
}

test("saves and resumes a draft without granting normal write tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lean-plan-extension-"));
  const harness = createHarness();
  leanPlanExtension(harness.pi);
  const ctx = harness.context(root);

  await harness.commands.get("lean-plan").handler("", ctx);
  assert.deepEqual(harness.activeTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "lean_finalize_plan",
    "lean_save_plan",
  ]);

  const result = await harness.tools
    .get("lean_save_plan")
    .execute("tool-call", sampleInput(), undefined, undefined, ctx);
  const draftDirectory = path.join(
    root,
    ".pi",
    "lean-drafts",
    "save-a-widget-plan",
  );
  const draft = await fs.readFile(path.join(draftDirectory, "DRAFT.md"), "utf8");
  assert.match(draft, /- Status: draft/);
  assert.match(draft, /Add widget storage/);
  await fs.access(path.join(draftDirectory, ".lean-plan.json"));
  await assert.rejects(fs.access(path.join(draftDirectory, "RALPH.md")));
  assert.equal(result.details.approved, false);

  await harness.hooks.get("agent_end")({}, ctx);
  assert.deepEqual(harness.activeTools(), ["read", "write", "bash"]);

  await harness.commands
    .get("lean-plan-resume")
    .handler(".pi/lean-drafts/save-a-widget-plan/DRAFT.md", ctx);
  assert.match(harness.messages.at(-1), /\[LEAN PLAN RESUME\]/);
  assert.match(harness.messages.at(-1), /Implement widget storage and focused tests/);
  assert.deepEqual(harness.activeTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "lean_finalize_plan",
    "lean_save_plan",
  ]);

  const revised = sampleInput();
  revised.tasks[0].instructions =
    "Implement durable widget storage with restart coverage.";
  revised.tasks[0].files = ["src/widgets.js", "tests/restart.test.js"];
  const updated = await harness.tools
    .get("lean_save_plan")
    .execute("tool-call-2", revised, undefined, undefined, ctx);
  assert.equal(updated.details.updated, true);
  assert.equal(
    (await fs.readdir(path.join(root, ".pi", "lean-drafts"))).length,
    1,
  );
  const revisedDraft = await fs.readFile(
    path.join(draftDirectory, "DRAFT.md"),
    "utf8",
  );
  assert.match(revisedDraft, /restart coverage/);
  assert.match(revisedDraft, /tests\/restart\.test\.js/);

  await harness.hooks.get("agent_end")({}, ctx);
  assert.deepEqual(harness.activeTools(), ["read", "write", "bash"]);
  await fs.rm(root, { recursive: true, force: true });
});
