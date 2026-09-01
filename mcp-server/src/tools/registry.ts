import { z } from "zod";
import { commandQueue } from "../commandQueue.js";
import { isToolAllowed, sanitizeCode } from "../security/policy.js";
import { healCode } from "../selfHeal.js";
import { rollbackManager } from "../rollback.js";
import { perfTracker } from "../perfTracker.js";
import { translate, detectEngine } from "../multiEngine.js";
import { validateLuau, makeSandboxTestHarness } from "../sandbox.js";
import { planFromPrompt } from "../planning.js";
import { buildContext } from "../contextInjection.js";
import { templateStore } from "../templates.js";
import { aiTraining } from "../aiTraining.js";
import { generateTests, buildHarness } from "../testGen.js";
import { autoCommit, gitLog } from "../gitCommit.js";
import { reviewLuau, refactoringPlan } from "../codeReview.js";
import { teamLog } from "../teamLog.js";
import { compileGraph, graphFromPrompt } from "../visualCompiler.js";
import { collabManager } from "../collab.js";
import { searchAssets, importInstruction } from "../assetStore.js";
import { gameplayFeedback } from "../gameplayFeedback.js";
import { generateGDD } from "../gdd.js";
import { generateAsset, generateVariants } from "../assetGen.js";
import { autoOptimize } from "../perfOptLoop.js";
import { analyticsEngine } from "../analytics.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
};

function queueAndWait(tool: string, command: string, args: Record<string, unknown>, timeoutMs = 15000) {
  if (!isToolAllowed(tool)) throw new Error(`tool not allowed: ${tool}`);
  const cmd = commandQueue.enqueue({ tool, command, args, timeoutMs });
  teamLog.append("info", (args.projectId as string) || "default", "mcp", `enqueue ${tool}`, { id: cmd.id });
  return { id: cmd.id, enqueued: cmd };
}

export const tools: ToolDef[] = [
  {
    name: "create_instance",
    description: "Create a Roblox instance. Check snapshot first. Queues Instance.new on plugin.",
    inputSchema: z.object({ className: z.string().describe("Roblox class e.g., Part, Script"), parent: z.string().default("workspace").describe("Parent path"), name: z.string().optional(), properties: z.record(z.unknown()).optional(), projectId: z.string().optional() }),
    handler: async (args) => {
      const { id } = queueAndWait("create_instance", `Instance.new("${args.className}")`, args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id, tool: "create_instance", args }) }] };
    }
  },
  {
    name: "run_code",
    description: "Execute Luau code in Studio plugin sandbox (HistoryService waypoint). Sanitized.",
    inputSchema: z.object({ code: z.string().describe("Luau code"), timeoutMs: z.number().optional(), projectId: z.string().optional() }),
    handler: async (args) => {
      const code = sanitizeCode(args.code);
      const v = validateLuau(code);
      if (!v.ok) return { content: [{ type: "text", text: JSON.stringify({ blocked:true, errors:v.errors, warnings:v.warnings }, null,2) }], isError:true };
      const personalized = aiTraining.personalize(code, args.projectId);
      const { id } = queueAndWait("run_code", personalized, args, args.timeoutMs);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id, warnings:v.warnings, personalized: personalized!==code }) }] };
    }
  },
  {
    name: "get_snapshot",
    description: "Request snapshot of game hierarchy from Studio plugin.",
    inputSchema: z.object({ maxDepth: z.number().optional(), filter: z.string().optional(), projectId: z.string().optional() }),
    handler: async (args) => {
      const { id } = queueAndWait("get_snapshot", "--snapshot", args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id }) }] };
    }
  },
  {
    name: "get_logs",
    description: "Get team log + queue status.",
    inputSchema: z.object({ limit: z.number().optional().default(20), projectId: z.string().optional() }),
    handler: async (args) => {
      const s = commandQueue.status(args.projectId);
      const logs = teamLog.query({ projectId: args.projectId, limit: args.limit });
      return { content: [{ type: "text", text: JSON.stringify({ queue:s, logs }, null, 2) }] };
    }
  },
  {
    name: "set_property",
    description: "Set property on instance.",
    inputSchema: z.object({ path: z.string(), property: z.string(), value: z.unknown(), projectId: z.string().optional() }),
    handler: async (args) => {
      const { id } = queueAndWait("set_property", `${args.path}.${args.property}=...`, args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id }) }] };
    }
  },
  {
    name: "undo",
    description: "Undo last change via HistoryService waypoint.",
    inputSchema: z.object({ steps: z.number().optional().default(1), projectId: z.string().optional() }),
    handler: async (args) => {
      const { id } = queueAndWait("undo", "--undo", args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id }) }] };
    }
  },
  // S1
  {
    name: "heal_code",
    description: "S1 Self-Heal: try to fix Luau code given error message using deterministic heuristics.",
    inputSchema: z.object({ code: z.string(), error: z.string() }),
    handler: async (args) => {
      const res = healCode(args.code, args.error);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  },
  // S2
  {
    name: "rollback",
    description: "S2 Rollback: revert N steps for project (marks history undone, enqueues undo).",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), steps: z.number().optional().default(1) }),
    handler: async (args) => {
      const entries = rollbackManager.rollback(args.projectId, args.steps);
      if (entries.length) queueAndWait("undo", "--rollback", { steps: entries.length, projectId: args.projectId });
      return { content: [{ type: "text", text: JSON.stringify({ rolledBack: entries, undoneCount: entries.length }, null,2) }] };
    }
  },
  {
    name: "rollback_list",
    description: "S2 List rollback history for project.",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), limit: z.number().optional().default(20) }),
    handler: async (args) => {
      const list = rollbackManager.list(args.projectId, args.limit);
      return { content: [{ type: "text", text: JSON.stringify(list, null,2) }] };
    }
  },
  // S3
  {
    name: "perf_stats",
    description: "S3 Perf: stats and recent timings from plugin execution.",
    inputSchema: z.object({ projectId: z.string().optional(), limit: z.number().optional().default(20) }),
    handler: async (args) => {
      return { content: [{ type: "text", text: JSON.stringify({ stats: perfTracker.stats(args.projectId), recent: perfTracker.recent(args.limit, args.projectId) }, null,2) }] };
    }
  },
  // S4
  {
    name: "translate_code",
    description: "S4 Multi-Engine: translate code between roblox/unity/godot.",
    inputSchema: z.object({ code: z.string(), from: z.enum(["roblox","unity","godot"]).optional(), to: z.enum(["roblox","unity","godot"]) }),
    handler: async (args) => {
      const from = args.from || detectEngine(args.code);
      const res = translate(args.code, from, args.to);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  // S5
  {
    name: "validate_code",
    description: "S5 Sandbox: validate Luau code statically (blocked patterns, warnings).",
    inputSchema: z.object({ code: z.string() }),
    handler: async (args) => {
      const r = validateLuau(args.code);
      return { content: [{ type: "text", text: JSON.stringify(r, null,2) }] };
    }
  },
  {
    name: "run_sandbox_tests",
    description: "S5 Run sandboxed tests: wraps code + tests in harness and queues to plugin.",
    inputSchema: z.object({ code: z.string(), tests: z.string().describe("Luau test code"), projectId: z.string().optional() }),
    handler: async (args) => {
      const harness = makeSandboxTestHarness(args.code, args.tests);
      const { id } = queueAndWait("run_code", harness, { code: harness, projectId: args.projectId } as any);
      return { content: [{ type: "text", text: JSON.stringify({ queued:true, id, harnessPreview: harness.slice(0,400) }) }] };
    }
  },
  // S6
  {
    name: "plan",
    description: "S6 Planning: natural language -> ordered steps with code previews and mermaid.",
    inputSchema: z.object({ prompt: z.string().describe("User request, e.g., 'make an obby'") }),
    handler: async (args) => {
      const p = planFromPrompt(args.prompt);
      return { content: [{ type: "text", text: JSON.stringify(p, null,2) }] };
    }
  },
  // S8
  {
    name: "get_context",
    description: "S8 Context Injection: builds AI context pack (snapshot, logs, templates).",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), snapshot: z.string().optional(), prompt: z.string().optional() }),
    handler: async (args) => {
      const ctx = buildContext({ projectId: args.projectId, snapshot: args.snapshot });
      return { content: [{ type: "text", text: JSON.stringify(ctx, null,2) }] };
    }
  },
  // S9
  {
    name: "list_templates",
    description: "S9 List templates (obby, leaderboard, shop).",
    inputSchema: z.object({ category: z.string().optional() }),
    handler: async (args) => {
      const list = templateStore.list(args.category);
      return { content: [{ type: "text", text: JSON.stringify(list, null,2) }] };
    }
  },
  {
    name: "use_template",
    description: "S9 Use template by id — enqueues its code/instances.",
    inputSchema: z.object({ id: z.string(), projectId: z.string().optional() }),
    handler: async (args) => {
      const t = templateStore.get(args.id);
      if (!t) return { content: [{ type: "text", text: JSON.stringify({ error:"not found" }) }], isError:true };
      if (t.code) queueAndWait("run_code", t.code, { templateId: t.id, projectId: args.projectId } as any);
      for (const inst of t.instances || []) queueAndWait("create_instance", `Instance.new("${inst.className}")`, { ...inst, projectId: args.projectId } as any);
      return { content: [{ type: "text", text: JSON.stringify({ used:true, template:t }, null,2) }] };
    }
  },
  {
    name: "create_template",
    description: "S9 Create custom template.",
    inputSchema: z.object({ id: z.string(), name: z.string(), description: z.string().optional().default(""), category: z.string().optional().default("custom"), code: z.string().optional().default("") }),
    handler: async (args) => {
      const t = templateStore.create({ id: args.id, name: args.name, description: args.description, category: args.category, code: args.code });
      return { content: [{ type: "text", text: JSON.stringify(t, null,2) }] };
    }
  },
  // S10
  {
    name: "style_profile",
    description: "S10 Get style profile learned from command history.",
    inputSchema: z.object({ projectId: z.string().optional().default("default") }),
    handler: async (args) => {
      const p = aiTraining.profile(args.projectId);
      return { content: [{ type: "text", text: JSON.stringify(p, null,2) }] };
    }
  },
  {
    name: "personalize_code",
    description: "S10 Personalize code to match your codebase style.",
    inputSchema: z.object({ code: z.string(), projectId: z.string().optional().default("default") }),
    handler: async (args) => {
      const out = aiTraining.personalize(args.code, args.projectId);
      return { content: [{ type: "text", text: JSON.stringify({ original: args.code, personalized: out }, null,2) }] };
    }
  },
  // S12
  {
    name: "generate_tests",
    description: "S12 Generate tests for Luau code and return harness.",
    inputSchema: z.object({ code: z.string() }),
    handler: async (args) => {
      const tests = generateTests(args.code);
      const harness = buildHarness(args.code, tests);
      return { content: [{ type: "text", text: JSON.stringify({ tests, harness }, null,2) }] };
    }
  },
  // S17
  {
    name: "git_commit",
    description: "S17 Auto git commit staged changes with message.",
    inputSchema: z.object({ message: z.string(), files: z.array(z.string()).optional() }),
    handler: async (args) => {
      const r = await autoCommit({ message: args.message, files: args.files });
      return { content: [{ type: "text", text: JSON.stringify(r, null,2) }], isError: !r.committed && !!r.error?.includes("nothing") ? false : !r.committed };
    }
  },
  {
    name: "git_log",
    description: "S17 Show git log.",
    inputSchema: z.object({ limit: z.number().optional().default(10) }),
    handler: async (args) => {
      const out = await gitLog(args.limit);
      return { content: [{ type: "text", text: out }] };
    }
  },
  // S20
  {
    name: "review_code",
    description: "S20 Code review & refactoring suggestions.",
    inputSchema: z.object({ code: z.string() }),
    handler: async (args) => {
      const rev = reviewLuau(args.code);
      const plan = refactoringPlan(args.code);
      return { content: [{ type: "text", text: JSON.stringify({ ...rev, refactoringPlan: plan }, null,2) }] };
    }
  },
  // S11
  {
    name: "compile_visual",
    description: "S11 Visual Scripting: compile node-graph JSON to Luau.",
    inputSchema: z.object({ graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }), projectId: z.string().optional() }),
    handler: async (args) => {
      const res = compileGraph(args.graph as any);
      if (!res.warnings.length) queueAndWait("run_code", res.luau, { visual: true, projectId: args.projectId } as any);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  {
    name: "visual_from_prompt",
    description: "S11 Generate visual graph from natural language then compile.",
    inputSchema: z.object({ prompt: z.string(), projectId: z.string().optional() }),
    handler: async (args) => {
      const graph = graphFromPrompt(args.prompt);
      const comp = compileGraph(graph);
      return { content: [{ type: "text", text: JSON.stringify({ graph, compiled: comp }, null,2) }] };
    }
  },
  // S14
  {
    name: "collab_join",
    description: "S14 Join collaborative session for projectId.",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), clientId: z.string(), role: z.enum(["extension","plugin","ai"]).optional().default("ai") }),
    handler: async (args) => {
      const c = collabManager.join(args.projectId, args.clientId, args.role as any);
      return { content: [{ type: "text", text: JSON.stringify(c, null,2) }] };
    }
  },
  {
    name: "collab_list",
    description: "S14 List collab clients for project.",
    inputSchema: z.object({ projectId: z.string().optional().default("default") }),
    handler: async (args) => {
      return { content: [{ type: "text", text: JSON.stringify(collabManager.list(args.projectId), null,2) }] };
    }
  },
  {
    name: "collab_broadcast",
    description: "S14 Broadcast event to collab session.",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), event: z.string(), data: z.any().optional(), from: z.string().optional().default("ai") }),
    handler: async (args) => {
      const b = collabManager.broadcast(args.projectId, args.event, args.data, args.from);
      return { content: [{ type: "text", text: JSON.stringify(b, null,2) }] };
    }
  },
  // S15
  {
    name: "search_assets",
    description: "S15 Search Roblox Library / Asset Store.",
    inputSchema: z.object({ keyword: z.string(), limit: z.number().optional().default(8), category: z.string().optional() }),
    handler: async (args) => {
      const res = await searchAssets(args.keyword, args.limit, args.category);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  {
    name: "import_asset",
    description: "S15 Import asset by ID into Roblox Studio (queues InsertService code).",
    inputSchema: z.object({ assetId: z.number(), parent: z.string().optional().default("workspace"), projectId: z.string().optional() }),
    handler: async (args) => {
      const code = importInstruction(args.assetId, args.parent);
      const { id } = queueAndWait("run_code", code, args as any);
      return { content: [{ type: "text", text: JSON.stringify({ queued:true, id, codePreview: code.slice(0,300) }) }] };
    }
  },
  // S16
  {
    name: "report_metrics",
    description: "S16 Report gameplay metrics (deaths/min, FPS, etc.) for feedback loop.",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), deathsPerMinute: z.number().optional(), avgFPS: z.number().optional(), killDeathRatio: z.number().optional(), completionTimeSec: z.number().optional(), coinsPerMin: z.number().optional(), activePlayers: z.number().optional() }),
    handler: async (args) => {
      const { projectId, ...rest } = args;
      const res = gameplayFeedback.ingest({ projectId, timestamp: Date.now(), ...rest } as any);
      if (res.triggers.length) teamLog.append("warn", projectId, "feedback", res.triggers.join("; "), rest);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  {
    name: "get_metrics",
    description: "S16 Get recent gameplay metrics.",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), limit: z.number().optional().default(20) }),
    handler: async (args) => {
      return { content: [{ type: "text", text: JSON.stringify(gameplayFeedback.recent(args.projectId, args.limit), null,2) }] };
    }
  },
  // S19
  {
    name: "generate_gdd",
    description: "S19 Natural language → Game Design Document + plan.",
    inputSchema: z.object({ prompt: z.string() }),
    handler: async (args) => {
      const gdd = generateGDD(args.prompt);
      return { content: [{ type: "text", text: JSON.stringify(gdd, null,2) }] };
    }
  },
  // S21
  {
    name: "generate_asset",
    description: "S21 Generate asset from text prompt (model or texture) via external API or procedural fallback.",
    inputSchema: z.object({ prompt: z.string(), kind: z.enum(["model","texture"]).optional().default("model"), projectId: z.string().optional() }),
    handler: async (args) => {
      const res = await generateAsset(args.prompt, args.kind as any);
      if (res.ok) queueAndWait("run_code", res.code, { generated:true, prompt: args.prompt, projectId: args.projectId } as any);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  {
    name: "generate_asset_variants",
    description: "S21 Generate multiple asset variants.",
    inputSchema: z.object({ prompt: z.string(), count: z.number().optional().default(3), kind: z.enum(["model","texture"]).optional().default("model") }),
    handler: async (args) => {
      const res = await generateVariants(args.prompt, args.count, args.kind as any);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  // S22
  {
    name: "optimize_perf",
    description: "S22 Automated performance optimization suggestions and code.",
    inputSchema: z.object({ projectId: z.string().optional().default("default"), snapshot: z.string().optional() }),
    handler: async (args) => {
      const res = autoOptimize(args.snapshot, args.projectId);
      return { content: [{ type: "text", text: JSON.stringify(res, null,2) }] };
    }
  },
  // S23
  {
    name: "analytics_report",
    description: "S23 Player behavior analytics full report.",
    inputSchema: z.object({ projectId: z.string().optional().default("default") }),
    handler: async (args) => {
      return { content: [{ type: "text", text: JSON.stringify(analyticsEngine.report(args.projectId), null,2) }] };
    }
  },
  {
    name: "analytics_suggestions",
    description: "S23 Design suggestions based on behavior.",
    inputSchema: z.object({ projectId: z.string().optional().default("default") }),
    handler: async (args) => {
      return { content: [{ type: "text", text: JSON.stringify(analyticsEngine.suggest(args.projectId), null,2) }] };
    }
  },
];
