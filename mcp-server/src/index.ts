import express from "express";
import cors from "cors";
import { commandQueue } from "./commandQueue.js";
import { tools } from "./tools/registry.js";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";
import { rollbackManager } from "./rollback.js";
import { perfTracker } from "./perfTracker.js";
import { healCode, shouldAutoHeal } from "./selfHeal.js";
import { teamLog } from "./teamLog.js";
import { commandQueue as cq } from "./commandQueue.js";
import { validateLuau } from "./sandbox.js";

const PORT = Number(process.env.MCP_PORT ?? 3001);
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const startTime = Date.now();

// lazy optional Phase E modules
let explainer: any = null;
let ddaEngine: any = null;
let soundGen: any = null;
async function loadOptional() {
  try { explainer = await import("./explainer.js"); } catch {}
  try { ddaEngine = await import("./ddaEngine.js"); } catch {}
  try { soundGen = await import("./soundGenerator.js"); } catch {}
}
loadOptional();

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: PROTOCOL_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    queueDepth: commandQueue.status().depth,
    tools: tools.length,
  });
});

// Enqueue
app.post("/queue/enqueue", (req, res) => {
  const { tool, command, args, priority, timeoutMs, projectId } = req.body ?? {};
  if (!tool || !command) return res.status(400).json({ error: "tool and command required" });
  // server-side sandbox check for run_code
  if (tool === "run_code" && typeof command === "string") {
    const v = validateLuau(command);
    if (!v.ok) return res.status(400).json({ ok:false, error:"sandbox blocked", details:v.errors });
  }
  try {
    const cmd = commandQueue.enqueue({ tool, command, args, priority, timeoutMs, projectId });
    teamLog.append("info", projectId || "default", "mcp", `enqueue ${tool}`, { id: cmd.id });
    rollbackManager.push({ id: cmd.id, projectId: projectId || "default", timestamp: Date.now(), tool, command: String(command).slice(0,5000) });
    console.log(`[enqueue] ${tool} id=${cmd.id} prio=${priority}`);
    res.json({ ok: true, id: cmd.id, queued: cmd });
  } catch (e: any) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get("/queue/next", (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const cmd = commandQueue.next(projectId);
  if (!cmd) return res.json({ ok: true, command: null });
  teamLog.append("info", (cmd.projectId || "default"), "plugin", "claimed", { id: cmd.id, tool: cmd.tool });
  res.json({ ok: true, command: cmd });
});

app.post("/queue/result", (req, res) => {
  const { id, result, error, timings, snapshot } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "id required" });
  const cmd = commandQueue.complete(id, result, error);
  if (!cmd) return res.status(404).json({ error: "not found" });

  const elapsed = timings?.elapsed ? Math.round(Number(timings.elapsed)*1000) : 0;
  const success = !error;
  perfTracker.record({ id, tool: cmd.tool, elapsedMs: elapsed || 0, timestamp: Date.now(), projectId: cmd.projectId || "default", success });
  teamLog.append(success ? "info" : "error", cmd.projectId || "default", "plugin", success ? `done ${cmd.tool}` : `failed ${cmd.tool}`, { id, error, elapsedMs: elapsed });

  if (timings) console.log(`[result] ${id} tool=${cmd.tool} elapsed=${elapsed}ms success=${success}`);
  if (snapshot) console.log(`[snapshot] ${id} len=${JSON.stringify(snapshot).length}`);
  if (error) console.warn(`[error] ${id}: ${String(error).slice(0,400)}`);

  // S1 auto-heal: if failed and healable, enqueue fixed version
  let healed: any = null;
  if (error && shouldAutoHeal(String(error))) {
    const hr = healCode(cmd.command, String(error));
    if (hr.healed && hr.fixed) {
      const newCmd = commandQueue.enqueue({ tool: cmd.tool, command: hr.fixed, args: { ...cmd.args, healedFrom: id }, priority: 9, projectId: cmd.projectId });
      teamLog.append("info", cmd.projectId || "default", "heal", `auto-healed ${id} -> ${newCmd.id}`, hr);
      healed = { healed:true, newId: newCmd.id, reason: hr.reason };
      console.log(`[heal] ${id} -> ${newCmd.id} reason=${hr.reason}`);
    }
  }

  res.json({ ok: true, updated: cmd, perf: { elapsedMs: elapsed, success }, healed });
});

app.get("/queue/status", (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  res.json({ ok: true, ...commandQueue.status(projectId) });
});

app.get("/queue/wait/:id", async (req, res) => {
  const timeout = Number(req.query.timeout ?? 15000);
  try {
    const result = await commandQueue.waitForResult(req.params.id, timeout);
    res.json({ ok: true, result });
  } catch (e: any) {
    res.status(504).json({ ok: false, error: e.message });
  }
});

// Team log query
app.get("/logs", (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const limit = Number(req.query.limit ?? 50);
  const logs = teamLog.query({ projectId, limit });
  res.json({ ok:true, logs });
});

// MCP tool inspector
app.get("/tools", (_req, res) => {
  res.json({ ok: true, tools: tools.map(t => ({ name: t.name, description: t.description })) });
});

app.post("/tools/call", async (req, res) => {
  const { name, arguments: args } = req.body ?? {};
  const tool = tools.find(t => t.name === name);
  if (!tool) return res.status(404).json({ error: "tool not found" });
  try {
    const parsed = tool.inputSchema.parse(args ?? {});
    const out = await tool.handler(parsed);
    res.json({ ok: true, ...out });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message, isError: true });
  }
});

// Convenience direct endpoints for Phase B (also available via /tools/call)
import { planFromPrompt } from "./planning.js";
import { reviewLuau, refactoringPlan } from "./codeReview.js";
import { templateStore } from "./templates.js";
import { buildContext } from "./contextInjection.js";
import { aiTraining } from "./aiTraining.js";

app.post("/plan", (req,res)=> {
  const p = planFromPrompt(req.body?.prompt || "");
  teamLog.append("info", req.body?.projectId||"default", "ai", "plan", { prompt: req.body?.prompt, steps: p.steps.length });
  res.json({ ok:true, plan: p });
});
app.post("/review", (req,res)=> {
  const r = reviewLuau(req.body?.code || "");
  const plan = refactoringPlan(req.body?.code || "");
  res.json({ ok:true, ...r, refactoringPlan: plan });
});
app.get("/templates", (req,res)=>{
  const cat = req.query.category as string|undefined;
  res.json({ ok:true, templates: templateStore.list(cat) });
});
app.post("/templates/use", (req,res)=>{
  const t = templateStore.get(req.body?.id);
  if (!t) return res.status(404).json({ ok:false, error:"not found" });
  // enqueue via commandQueue
  if (t.code) cq.enqueue({ tool:"run_code", command:t.code, args:{ templateId:t.id } });
  for (const i of t.instances||[]) cq.enqueue({ tool:"create_instance", command:`Instance.new("${i.className}")`, args:i as any });
  res.json({ ok:true, template:t });
});
app.get("/context", (req,res)=>{
  const ctx = buildContext({ projectId: req.query.projectId as string || "default", snapshot: req.query.snapshot as string || "" });
  res.json({ ok:true, context: ctx });
});
app.get("/style", (req,res)=>{
  const p = aiTraining.profile(req.query.projectId as string || "default");
  res.json({ ok:true, profile:p });
});
app.get("/perf", (req,res)=>{
  const pid = req.query.projectId as string|undefined;
  res.json({ ok:true, stats: perfTracker.stats(pid), recent: perfTracker.recent(20, pid) });
});
app.get("/rollback", (req,res)=>{
  const pid = req.query.projectId as string || "default";
  res.json({ ok:true, history: rollbackManager.list(pid, Number(req.query.limit||20)) });
});
app.post("/rollback", (req,res)=>{
  const pid = req.body?.projectId || "default";
  const steps = Number(req.body?.steps || 1);
  const entries = rollbackManager.rollback(pid, steps);
  if (entries.length) cq.enqueue({ tool:"undo", command:"--rollback", args:{ steps: entries.length, projectId: pid } });
  res.json({ ok:true, rolledBack: entries });
});

// Stubs for Phase E (so UI doesn't 404)
app.post("/explain_code", async (req, res) => {
  if (explainer?.explain_code) {
    const out = await explainer.explain_code(req.body?.scriptPath ?? "unknown");
    return res.json({ ok: true, explanation: out });
  }
  res.json({ ok: true, note: "explainer not yet implemented (Phase E)", mock: { overview: "This script handles player health.", flow: "graph TD; A-->B" } });
});

app.post("/dda/:action", async (req, res) => {
  if (ddaEngine) {
    if (req.params.action === "adjust") return res.json({ ok: true, result: await ddaEngine.adjust_difficulty() });
    if (req.params.action === "profile") return res.json({ ok: true, result: await ddaEngine.set_difficulty_profile(req.body?.profile) });
  }
  res.json({ ok: true, note: "DDA not yet implemented (Phase E)", profile: req.body?.profile ?? "adaptive" });
});

app.post("/sound/:action", async (req, res) => {
  if (soundGen) {
    if (req.params.action === "generate") return res.json({ ok: true, result: await soundGen.generate_sound(req.body?.prompt, req.body?.type) });
    if (req.params.action === "pack") return res.json({ ok: true, result: await soundGen.generate_sound_pack(req.body?.prompt, req.body?.count) });
  }
  res.json({ ok: true, note: "soundGenerator not yet implemented (Phase E)", prompt: req.body?.prompt });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[mcp-server] listening on http://127.0.0.1:${PORT} (v${PROTOCOL_VERSION}) tools=${tools.length}`);
});

setInterval(async () => {
  if (ddaEngine?.shouldAutoAdjust?.()) {
    try { await ddaEngine.adjust_difficulty(); } catch (e) { console.error("[dda] auto adjust failed", e); }
  }
}, 5 * 60 * 1000).unref?.();

if (process.argv.includes("--stdio")) {
  console.error("[mcp] stdio mode not yet wired, HTTP mode active");
}
