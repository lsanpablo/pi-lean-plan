import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  PLAN_FILE,
  PLAN_STATE_FILE,
  QUESTIONS_FILE,
  RALPH_FILE,
  formatModelSelector,
  normalizePlan,
  renderApprovalPreview,
  renderOpenQuestionsMarkdown,
  renderPlanMarkdown,
  renderRalphMarkdown,
} from "./core.js";
import { executePlan, loadPlanDirectory } from "./runner.js";

const PLAN_TOOLS = ["read", "grep", "find", "ls", "laguna_finalize_plan"];

async function writeExclusive(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
}

async function createUniquePlanDirectory(cwd, slug) {
  const root = path.join(cwd, ".pi", "plans");
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

function relativeDisplayPath(cwd, target) {
  const relative = path.relative(cwd, target);
  return relative === "" ? "." : relative;
}

export default function lagunaPlanRunner(pi) {
  let planning = false;
  let planFinalized = false;
  let savedTools = null;
  let activeRun = null;

  const restoreTools = (ctx) => {
    if (savedTools) pi.setActiveTools(savedTools);
    savedTools = null;
    planning = false;
    planFinalized = false;
    if (ctx.hasUI) ctx.ui.setStatus("laguna-plan", undefined);
  };

  pi.registerTool({
    name: "laguna_finalize_plan",
    label: "Finalize Laguna plan",
    description:
      "Present a sequential implementation plan for approval, then write PLAN.md, RALPH.md, and OPEN_QUESTIONS.md. This never starts implementation.",
    parameters: Type.Object({
      title: Type.String({ description: "Short implementation plan title" }),
      summary: Type.String({ description: "Scope, approach, and important constraints" }),
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "Small, outcome-oriented task title" }),
          instructions: Type.String({
            description: "Complete instructions usable by a fresh worker with no chat history",
          }),
          files: Type.Optional(
            Type.Array(Type.String(), {
              description: "Likely project-relative files to inspect or edit",
            }),
          ),
          verification: Type.String({
            description: "One non-interactive shell command that proves this task succeeded",
          }),
        }),
        { minItems: 1, maxItems: 30 },
      ),
      final_verification: Type.String({
        description: "One non-interactive shell command that verifies the entire plan",
      }),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      if (!planning || planFinalized) {
        throw new Error("Start a new planning session with /laguna-plan first.");
      }
      if (!ctx.hasUI) {
        throw new Error("Plan finalization requires Pi's interactive UI for explicit approval.");
      }

      const plan = normalizePlan(input);
      const approved = await ctx.ui.confirm(
        `Approve ${plan.tasks.length}-task plan?`,
        renderApprovalPreview(plan),
      );
      if (!approved) {
        return {
          content: [
            {
              type: "text",
              text: "Plan was not approved. Ask what should change, revise it, and call this tool again.",
            },
          ],
          details: { approved: false },
        };
      }

      const planDir = await createUniquePlanDirectory(ctx.cwd, plan.slug);
      try {
        await writeExclusive(
          path.join(planDir, PLAN_STATE_FILE),
          `${JSON.stringify(plan, null, 2)}\n`,
        );
        await writeExclusive(path.join(planDir, PLAN_FILE), renderPlanMarkdown(plan));
        await writeExclusive(path.join(planDir, RALPH_FILE), renderRalphMarkdown(plan));
        await writeExclusive(
          path.join(planDir, QUESTIONS_FILE),
          renderOpenQuestionsMarkdown(plan),
        );
      } catch (error) {
        await fs.rm(planDir, { recursive: true, force: true });
        throw error;
      }

      planFinalized = true;
      const displayPath = relativeDisplayPath(ctx.cwd, planDir);
      if (ctx.hasUI) {
        ctx.ui.setStatus("laguna-plan", ctx.ui.theme.fg("success", "plan approved"));
      }
      return {
        content: [
          {
            type: "text",
            text: `Approved plan written to ${displayPath}. Do not implement it in this turn. Tell the user to run /laguna-run ${displayPath}.`,
          },
        ],
        details: {
          approved: true,
          planDirectory: displayPath,
          tasks: plan.tasks.length,
        },
      };
    },
  });

  pi.registerCommand("laguna-plan", {
    description: "Explore read-only and create an approved sequential plan",
    handler: async (args, ctx) => {
      if (activeRun) {
        ctx.ui.notify("Stop the active runner before starting a new plan.", "warning");
        return;
      }
      if (planning) {
        ctx.ui.notify("Laguna planning mode is already active.", "info");
        return;
      }
      savedTools = pi.getActiveTools();
      planning = true;
      planFinalized = false;
      pi.setActiveTools(PLAN_TOOLS);
      ctx.ui.setStatus("laguna-plan", ctx.ui.theme.fg("warning", "read-only planning"));
      ctx.ui.notify("Read-only planning enabled. Finalization requires your approval.", "info");
      if (args.trim()) {
        pi.sendUserMessage(args.trim());
      }
    },
  });

  pi.registerCommand("laguna-plan-exit", {
    description: "Leave Laguna planning mode without writing a plan",
    handler: async (_args, ctx) => {
      if (!planning) {
        ctx.ui.notify("Laguna planning mode is not active.", "info");
        return;
      }
      restoreTools(ctx);
      ctx.ui.notify("Laguna planning mode disabled.", "info");
    },
  });

  pi.registerCommand("laguna-run", {
    description: "Run the latest or specified approved plan one task at a time",
    handler: async (args, ctx) => {
      if (planning) {
        ctx.ui.notify("Finish or exit planning mode before starting the runner.", "warning");
        return;
      }
      if (activeRun) {
        ctx.ui.notify("A Laguna plan is already running.", "warning");
        return;
      }

      let planDir;
      try {
        planDir = await loadPlanDirectory(ctx.cwd, args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Start Laguna runner?",
        `Plan: ${relativeDisplayPath(ctx.cwd, planDir)}

The controller will start a fresh Pi process for each task, allow at most two
attempts per task, execute every approved verification command, and update
checkboxes only after verification succeeds.`,
      );
      if (!confirmed) return;

      const abortController = new AbortController();
      const runToken = { abortController, planDir };
      activeRun = runToken;
      const modelSelector = formatModelSelector(ctx.model);
      const thinkingLevel = pi.getThinkingLevel();
      ctx.ui.setStatus("laguna-run", ctx.ui.theme.fg("accent", "starting"));

      void (async () => {
        try {
          const result = await executePlan({
            projectCwd: ctx.cwd,
            planDir,
            modelSelector,
            thinkingLevel,
            signal: abortController.signal,
            onEvent(event) {
              if (event.type === "task-attempt-started") {
                ctx.ui.setStatus(
                  "laguna-run",
                  ctx.ui.theme.fg(
                    "accent",
                    `${event.task.id} attempt ${event.attempt}`,
                  ),
                );
              } else if (event.type === "task-completed") {
                ctx.ui.notify(`${event.task.id} verified and checked off.`, "success");
              } else if (event.type === "final-verification-started") {
                ctx.ui.setStatus(
                  "laguna-run",
                  ctx.ui.theme.fg("accent", "final verification"),
                );
              }
            },
          });

          const displayPath = relativeDisplayPath(ctx.cwd, result.planDir);
          if (result.status === "complete") {
            ctx.ui.notify(
              `LAGUNA_PLAN_COMPLETE\n${result.completed} tasks verified.\n${displayPath}/${PLAN_FILE}`,
              "success",
            );
          } else {
            ctx.ui.notify(
              `${result.status}: ${result.reason}\nSee ${displayPath}/logs`,
              result.status === "aborted" ? "warning" : "error",
            );
          }
        } catch (error) {
          ctx.ui.notify(
            `Laguna runner error: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        } finally {
          if (activeRun === runToken) activeRun = null;
          ctx.ui.setStatus("laguna-run", undefined);
        }
      })();
    },
  });

  pi.registerCommand("laguna-stop", {
    description: "Stop the active Laguna child process after its current signal",
    handler: async (_args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No Laguna plan is running.", "info");
        return;
      }
      activeRun.abortController.abort();
      ctx.ui.notify("Stopping the active Laguna worker…", "warning");
    },
  });

  pi.on("before_agent_start", async () => {
    if (!planning) return;
    return {
      message: {
        customType: "laguna-plan-context",
        display: false,
        content: `[LAGUNA READ-ONLY PLANNING MODE]

Explore the local project with read, grep, find, and ls. Do not implement or edit.
Build a short sequential plan suitable for a weaker implementation model.

Each task must:
- fit one fresh worker process with no access to this chat;
- include all necessary context and likely files;
- have one concrete, non-interactive verification command;
- avoid depending on implicit memory from earlier tasks.

Ask the user directly about unresolved product or architecture decisions. When the
plan has no blocking questions, call laguna_finalize_plan exactly once. The tool
assigns task IDs and dependencies, displays the plan for explicit approval, and
writes the artifacts. After calling it, do not implement anything.`,
      },
    };
  });

  pi.on("tool_call", async (event) => {
    if (!planning) return;
    if (!PLAN_TOOLS.includes(event.toolName)) {
      return {
        block: true,
        reason: `Laguna planning is read-only. ${event.toolName} is unavailable until planning ends.`,
      };
    }
    if (planFinalized && event.toolName !== "laguna_finalize_plan") {
      return {
        block: true,
        reason: "The plan is finalized. End the response without further tool calls.",
      };
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (planning && planFinalized) restoreTools(ctx);
  });

  pi.on("session_shutdown", async () => {
    activeRun?.abortController.abort();
    activeRun = null;
  });
}
