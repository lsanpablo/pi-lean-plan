import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  DRAFT_FILE,
  FINAL_CHECK_FILE,
  PLAN_CHECK_FILE,
  PLAN_FILE,
  PLAN_HTML_FILE,
  PLAN_STATE_FILE,
  QUESTIONS_FILE,
  RALPH_FILE,
  assertPathInside,
  normalizePlan,
  renderApprovalPreview,
  renderDraftMarkdown,
  renderFinalVerificationScript,
  renderOpenQuestionsMarkdown,
  renderPlanCheckScript,
  renderPlanHtml,
  renderPlanMarkdown,
  renderRefinementRequest,
  renderResumeRequest,
  renderRalphMarkdown,
  validatePlan,
} from "./core.js";

const PLAN_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "lean_finalize_plan",
  "lean_save_plan",
];
const REFINE_PLAN = "Refine with instructions";
const SAVE_DRAFT = "Save draft and exit";
const CONTINUE_IN_CHAT = "Continue in chat";

function planParameters() {
  return Type.Object({
    title: Type.String({ description: "Short plan title" }),
    objective: Type.String({
      description: "Concrete outcome, scope, constraints, and important behavior",
    }),
    tasks: Type.Array(
      Type.Object({
        title: Type.String({ description: "Small outcome-oriented task title" }),
        instructions: Type.String({
          description: "Standalone instructions for a fresh Ralph iteration",
        }),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description: "Likely project-relative files to inspect or edit",
          }),
        ),
        verification: Type.String({
          description: "Non-interactive shell command proving this task succeeded",
        }),
      }),
      { minItems: 1, maxItems: 12 },
    ),
    final_verification: Type.String({
      description: "Non-interactive command used as Ralph acceptance evidence",
    }),
  });
}

async function writeExclusive(filePath, content, mode = 0o644) {
  await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode });
}

async function writeAtomic(filePath, content, mode = 0o644) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function createUniqueDirectory(cwd, collection, slug) {
  const root = path.join(cwd, ".pi", collection);
  await fs.mkdir(root, { recursive: true });
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const name = suffix === 1 ? slug : `${slug}-${suffix}`;
    const candidate = path.join(root, name);
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not allocate a unique plan directory for ${slug}`);
}

async function createUniquePlanDirectory(cwd, slug) {
  return createUniqueDirectory(cwd, "lean-plans", slug);
}

async function createUniqueDraftDirectory(cwd, slug) {
  return createUniqueDirectory(cwd, "lean-drafts", slug);
}

async function writeDraftPackage(cwd, plan) {
  const draftDirectory = await createUniqueDraftDirectory(cwd, plan.slug);
  try {
    await writeExclusive(
      path.join(draftDirectory, PLAN_STATE_FILE),
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    await writeExclusive(
      path.join(draftDirectory, DRAFT_FILE),
      renderDraftMarkdown(plan),
    );
  } catch (error) {
    await fs.rm(draftDirectory, { recursive: true, force: true });
    throw error;
  }
  return draftDirectory;
}

function displayPath(cwd, target) {
  const relative = path.relative(cwd, target);
  return relative === "" ? "." : relative;
}

function hasRalphExtension(pi) {
  return pi
    .getCommands()
    .some((command) => command.name === "ralph" && command.source === "extension");
}

async function resolvePlanDirectory(cwd, requestedPath) {
  const root = path.join(cwd, ".pi", "lean-plans");
  let candidate;

  if (requestedPath.trim()) {
    const requested = path.resolve(cwd, requestedPath.trim());
    candidate = [RALPH_FILE, PLAN_FILE].includes(path.basename(requested))
      ? path.dirname(requested)
      : requested;
  } else {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      throw new Error("No Lean plans found. Start with /lean-plan <request>.");
    }
    const plans = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      const ralphPath = path.join(directory, RALPH_FILE);
      try {
        const stat = await fs.stat(ralphPath);
        plans.push({ directory, modified: stat.mtimeMs });
      } catch {
        // Ignore incomplete directories.
      }
    }
    plans.sort((a, b) => b.modified - a.modified);
    if (plans.length === 0) {
      throw new Error("No Lean plans found. Start with /lean-plan <request>.");
    }
    candidate = plans[0].directory;
  }

  assertPathInside(cwd, candidate);
  await fs.access(path.join(candidate, RALPH_FILE), fsConstants.R_OK);
  await fs.access(path.join(candidate, PLAN_FILE), fsConstants.R_OK);
  return candidate;
}

async function resolveStoredPlan(cwd, requestedPath) {
  const draftRoot = path.join(cwd, ".pi", "lean-drafts");
  let candidate;

  if (requestedPath.trim()) {
    const requested = path.resolve(cwd, requestedPath.trim());
    candidate = [DRAFT_FILE, PLAN_FILE, PLAN_STATE_FILE].includes(
      path.basename(requested),
    )
      ? path.dirname(requested)
      : requested;
  } else {
    let entries;
    try {
      entries = await fs.readdir(draftRoot, { withFileTypes: true });
    } catch {
      throw new Error(
        "No saved Lean drafts found. Ask the planner to save one with lean_save_plan.",
      );
    }
    const drafts = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(draftRoot, entry.name);
      const statePath = path.join(directory, PLAN_STATE_FILE);
      try {
        const stat = await fs.stat(statePath);
        drafts.push({ directory, modified: stat.mtimeMs });
      } catch {
        // Ignore incomplete draft directories.
      }
    }
    drafts.sort((a, b) => b.modified - a.modified);
    if (drafts.length === 0) {
      throw new Error(
        "No saved Lean drafts found. Ask the planner to save one with lean_save_plan.",
      );
    }
    candidate = drafts[0].directory;
  }

  assertPathInside(cwd, candidate);
  const statePath = path.join(candidate, PLAN_STATE_FILE);
  const stateText = await fs.readFile(statePath, "utf8");
  const plan = validatePlan(JSON.parse(stateText));
  const draftPath = path.join(candidate, DRAFT_FILE);
  const approvedPath = path.join(candidate, PLAN_FILE);
  let sourcePath;
  try {
    await fs.access(draftPath, fsConstants.R_OK);
    sourcePath = draftPath;
  } catch {
    await fs.access(approvedPath, fsConstants.R_OK);
    sourcePath = approvedPath;
  }
  return { directory: candidate, plan, sourcePath };
}

export default function leanPlanExtension(pi) {
  let planning = false;
  let planFinalized = false;
  let savedTools = null;
  let currentDraft = null;

  const startPlanning = (ctx, draft = null) => {
    savedTools = pi.getActiveTools();
    planning = true;
    planFinalized = false;
    currentDraft = draft;
    pi.setActiveTools(PLAN_TOOLS);
    ctx.ui.setStatus("lean-plan", ctx.ui.theme.fg("warning", "read-only planning"));
  };

  const restoreTools = (ctx) => {
    if (savedTools) pi.setActiveTools(savedTools);
    savedTools = null;
    planning = false;
    planFinalized = false;
    currentDraft = null;
    if (ctx.hasUI) ctx.ui.setStatus("lean-plan", undefined);
  };

  const saveDraft = async (ctx, plan) => {
    const draftDirectory = await writeDraftPackage(ctx.cwd, plan);
    planFinalized = true;
    return displayPath(ctx.cwd, draftDirectory).replaceAll(path.sep, "/");
  };

  pi.registerTool({
    name: "lean_save_plan",
    label: "Save Lean plan draft",
    description:
      "Save a structured plan as resumable Markdown without approving it or creating a Ralph task. Call only when the user explicitly asks to save or defer the plan.",
    parameters: planParameters(),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      if (!planning || planFinalized) {
        throw new Error("Start a new planning session with /lean-plan first.");
      }
      const plan = normalizePlan(input);
      currentDraft = plan;
      const relativeDirectory = await saveDraft(ctx, plan);
      return {
        content: [
          {
            type: "text",
            text:
              `Draft written to ${relativeDirectory}/${DRAFT_FILE}. ` +
              `Do not implement it. Tell the user they can open a new session and run ` +
              `/lean-plan-resume ${relativeDirectory}.`,
          },
        ],
        details: {
          saved: true,
          approved: false,
          draftDirectory: relativeDirectory,
        },
      };
    },
  });

  pi.registerTool({
    name: "lean_finalize_plan",
    label: "Finalize Lean plan",
    description:
      "Present a sequential plan for approval and write a native pi-ralph-loop task package. This never runs a loop itself.",
    parameters: planParameters(),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      if (!planning || planFinalized) {
        throw new Error("Start a new planning session with /lean-plan first.");
      }
      if (!ctx.hasUI) {
        throw new Error("Plan finalization requires Pi's interactive UI for approval.");
      }

      const plan = normalizePlan(input);
      currentDraft = plan;
      const approved = await ctx.ui.confirm(
        `Approve ${plan.tasks.length}-task Lean plan?`,
        renderApprovalPreview(plan),
      );
      if (!approved) {
        const nextAction = await ctx.ui.select(
          "The plan was not approved. What next?",
          [REFINE_PLAN, SAVE_DRAFT, CONTINUE_IN_CHAT],
        );
        if (nextAction === REFINE_PLAN) {
          const feedback = await ctx.ui.editor(
            "Describe additions, removals, or corrections",
            "",
          );
          if (feedback?.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: renderRefinementRequest(plan, feedback),
                },
              ],
              details: {
                approved: false,
                action: "refine",
                feedback: feedback.trim(),
              },
            };
          }
        }
        if (nextAction === SAVE_DRAFT) {
          const relativeDirectory = await saveDraft(ctx, plan);
          return {
            content: [
              {
                type: "text",
                text:
                  `Unapproved draft written to ${relativeDirectory}/${DRAFT_FILE}. ` +
                  `Do not implement it. Tell the user they can open a new session and run ` +
                  `/lean-plan-resume ${relativeDirectory}.`,
              },
            ],
            details: {
              approved: false,
              action: "save",
              draftDirectory: relativeDirectory,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                "Plan not approved and no refinement instructions were submitted. " +
                "Do not guess at changes or resubmit the plan. End this turn and wait " +
                "for the user's next message.",
            },
          ],
          details: { approved: false, action: "wait" },
        };
      }

      const planDirectory = await createUniquePlanDirectory(ctx.cwd, plan.slug);
      const relativeDirectory = displayPath(ctx.cwd, planDirectory).replaceAll(path.sep, "/");
      try {
        await writeExclusive(
          path.join(planDirectory, PLAN_STATE_FILE),
          `${JSON.stringify(plan, null, 2)}\n`,
        );
        await writeExclusive(path.join(planDirectory, PLAN_FILE), renderPlanMarkdown(plan));
        await writeExclusive(
          path.join(planDirectory, QUESTIONS_FILE),
          renderOpenQuestionsMarkdown(),
        );
        await writeExclusive(
          path.join(planDirectory, PLAN_CHECK_FILE),
          renderPlanCheckScript(plan),
          0o755,
        );
        await writeExclusive(
          path.join(planDirectory, FINAL_CHECK_FILE),
          renderFinalVerificationScript(plan),
          0o755,
        );
        await writeExclusive(
          path.join(planDirectory, RALPH_FILE),
          renderRalphMarkdown(plan, relativeDirectory),
        );
      } catch (error) {
        await fs.rm(planDirectory, { recursive: true, force: true });
        throw error;
      }

      planFinalized = true;
      const ralphReady = hasRalphExtension(pi);
      return {
        content: [
          {
            type: "text",
            text: ralphReady
              ? `Approved native Ralph task written to ${relativeDirectory}. Do not implement it in this turn. Tell the user to run /lean-run ${relativeDirectory}.`
              : `Approved native Ralph task written to ${relativeDirectory}. @lnilluv/pi-ralph-loop is not loaded. Tell the user to install it, reload Pi, then run /lean-run ${relativeDirectory}.`,
          },
        ],
        details: {
          approved: true,
          planDirectory: relativeDirectory,
          ralphExtensionLoaded: ralphReady,
        },
      };
    },
  });

  pi.registerCommand("lean-plan", {
    description: "Explore read-only and create an approved pi-ralph-loop plan",
    handler: async (args, ctx) => {
      if (planning) {
        ctx.ui.notify("Lean planning mode is already active.", "info");
        return;
      }
      startPlanning(ctx);
      ctx.ui.notify(
        "Read-only planning enabled. Approve for Ralph or save a resumable draft.",
        "info",
      );
      if (args.trim()) pi.sendUserMessage(args.trim());
    },
  });

  pi.registerCommand("lean-plan-exit", {
    description: "Leave Lean planning mode without writing a plan",
    handler: async (_args, ctx) => {
      if (!planning) {
        ctx.ui.notify("Lean planning mode is not active.", "info");
        return;
      }
      restoreTools(ctx);
      ctx.ui.notify("Lean planning mode disabled.", "info");
    },
  });

  pi.registerCommand("lean-plan-save", {
    description: "Save the most recently submitted Lean plan as a resumable draft",
    handler: async (_args, ctx) => {
      if (!planning) {
        ctx.ui.notify("Lean planning mode is not active.", "info");
        return;
      }
      if (planFinalized) {
        ctx.ui.notify("The current plan has already been stored.", "info");
        return;
      }
      if (!currentDraft) {
        ctx.ui.notify(
          "No structured draft is available yet. Ask the planner to save the plan first.",
          "warning",
        );
        return;
      }
      try {
        const relativeDirectory = await saveDraft(ctx, currentDraft);
        restoreTools(ctx);
        ctx.ui.notify(
          `Draft written to ${relativeDirectory}/${DRAFT_FILE}. Resume with /lean-plan-resume ${relativeDirectory}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("lean-plan-resume", {
    description: "Load a saved draft or approved plan into read-only planning",
    handler: async (args, ctx) => {
      if (planning) {
        ctx.ui.notify("Lean planning mode is already active.", "info");
        return;
      }
      try {
        const stored = await resolveStoredPlan(ctx.cwd, args);
        const source = displayPath(ctx.cwd, stored.sourcePath).replaceAll(path.sep, "/");
        startPlanning(ctx, stored.plan);
        ctx.ui.notify(`Read-only planning resumed from ${source}.`, "info");
        pi.sendUserMessage(renderResumeRequest(stored.plan, source));
      } catch (error) {
        if (planning) restoreTools(ctx);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("lean-run", {
    description: "Start an approved Lean plan through pi-ralph-loop",
    handler: async (args, ctx) => {
      if (planning) {
        ctx.ui.notify("Finish or exit planning mode first.", "warning");
        return;
      }
      if (!hasRalphExtension(pi)) {
        ctx.ui.notify(
          "pi-ralph-loop is not loaded. Install npm:@lnilluv/pi-ralph-loop@2.0.0, then /reload.",
          "error",
        );
        return;
      }

      let planDirectory;
      try {
        planDirectory = await resolvePlanDirectory(ctx.cwd, args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const relativeDirectory = displayPath(ctx.cwd, planDirectory).replaceAll(path.sep, "/");
      pi.sendUserMessage(`/ralph --path ${JSON.stringify(relativeDirectory)}`);
    },
  });

  pi.registerCommand("lean-plan-view", {
    description: "Render a generated Lean plan as a visual Tailwind HTML file",
    handler: async (args, ctx) => {
      if (planning) {
        ctx.ui.notify("Approve or exit the current planning session first.", "warning");
        return;
      }

      let planDirectory;
      try {
        planDirectory = await resolvePlanDirectory(ctx.cwd, args);
        const statePath = path.join(planDirectory, PLAN_STATE_FILE);
        const planPath = path.join(planDirectory, PLAN_FILE);
        const cssPath = new URL("./plan-tailwind.css", import.meta.url);
        const [stateText, planMarkdown, tailwindCss] = await Promise.all([
          fs.readFile(statePath, "utf8"),
          fs.readFile(planPath, "utf8"),
          fs.readFile(cssPath, "utf8"),
        ]);
        const plan = JSON.parse(stateText);
        const html = renderPlanHtml(plan, planMarkdown, tailwindCss);
        const outputPath = path.join(planDirectory, PLAN_HTML_FILE);
        assertPathInside(ctx.cwd, outputPath);
        await writeAtomic(outputPath, html);
        ctx.ui.notify(
          `Visual plan written to ${displayPath(ctx.cwd, outputPath).replaceAll(path.sep, "/")}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("before_agent_start", async () => {
    if (!planning) return;
    return {
      message: {
        customType: "lean-plan-context",
        display: false,
        content: `[LEAN READ-ONLY PLANNING MODE]

Explore the local project with read, grep, find, and ls. Do not implement or edit.
Create a short sequential plan for @lnilluv/pi-ralph-loop.

Each task must:
- fit one fresh Ralph iteration with no chat history;
- contain standalone instructions and likely files;
- have one objective, non-interactive verification command;
- depend only on earlier checked tasks;
- avoid unresolved product or architecture choices.

Ask the user directly about decisions that change scope or architecture. Prefer
3–8 tasks. When no blocking questions remain, call lean_finalize_plan exactly
once unless the user explicitly asks to save or defer the plan. In that case,
call lean_save_plan exactly once instead. Saving writes resumable Markdown but
does not approve the plan or create a Ralph task. Finalizing creates PLAN.md and
a native RALPH.md with acceptance commands and a required completion gate. If
the user rejects a draft, follow the finalizer's returned refinement instructions
exactly. If it says to wait, do not guess or independently regenerate the plan.
After saving or finalizing, do not implement.`,
      },
    };
  });

  pi.on("tool_call", async (event) => {
    if (!planning) return;
    if (!PLAN_TOOLS.includes(event.toolName)) {
      return {
        block: true,
        reason: `Lean planning is read-only. ${event.toolName} is unavailable until planning ends.`,
      };
    }
    if (planFinalized) {
      return {
        block: true,
        reason: "The plan has been stored. End the response without further tool calls.",
      };
    }
  });

  pi.on("context", async (event) => {
    if (planning) return;
    return {
      messages: event.messages.filter(
        (message) => message?.customType !== "lean-plan-context",
      ),
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (planning && planFinalized) restoreTools(ctx);
  });
}
