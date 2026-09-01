import express from "express";
import cors from "cors";
import { commandQueue } from "./commandQueue.js";
import { tools } from "./tools/registry.js";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";

const PORT = Number(process.env.MCP_PORT ?? 3001);
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const startTime = Date.now();

// placeholder for future S43/S45/S48 modules — integrated via lazy import
let explainer: any = null;
let ddaEngine: any = null;
let soundGen: any = null;
async function loadOptionalModules() {
  try { explainer = await import("./explainer.js"); } catch {}
  try { ddaEngine = await import("./ddaEngine.js"); } catch {}
  try { soundGen = await import("./soundGenerator.js"); } catch {}
}
loadOptionalModules();

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

// Enqueue from extension/bridge
app.post("/queue/enqueue", (req, res) => {
  const { tool, command, args, priority, timeoutMs, projectId } = req.body ?? {};
  if (!tool || !command) return res.status(400).json({ error: "tool and command required" });
  try {
    const cmd = commandQueue.enqueue({ tool, command, args, priority, timeoutMs, projectId });
    // also log to team log
    console.log(`[enqueue] ${tool} id=${cmd.id} prio=${priority}`);
    res.json({ ok: true, id: cmd.id, queued: cmd });
  } catch (e: any) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Plugin polling: GET next command
app.get("/queue/next", (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const cmd = commandQueue.next(projectId);
  if (!cmd) return res.json({ ok: true, command: null });
  res.json({ ok: true, command: cmd });
});

app.post("/queue/result", (req, res) => {
  const { id, result, error, timings, snapshot } = req.body ?? {};
  if (!id) return res.status(400).json({ error: "id required" });
  const cmd = commandQueue.complete(id, result, error);
  if (!cmd) return res.status(404).json({ error: "not found" });
  if (timings) console.log(`[result] ${id} timings=${JSON.stringify(timings)}`);
  if (snapshot) console.log(`[snapshot] ${id} snapshot len=${JSON.stringify(snapshot).length}`);
  res.json({ ok: true, updated: cmd });
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

// MCP tool list (for inspector)
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

// Stub endpoints for future S43/S45/S48 so extension UI doesn't 404 during Phase A
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

// Graceful DDA interval if adaptive (future)
setInterval(async () => {
  if (ddaEngine?.shouldAutoAdjust?.()) {
    try { await ddaEngine.adjust_difficulty(); } catch (e) { console.error("[dda] auto adjust failed", e); }
  }
}, 5 * 60 * 1000).unref?.();

// MCP SDK stdio mode (optional) — if process arg --stdio, start MCP server
if (process.argv.includes("--stdio")) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  // minimal stdio wrapper for Claude Desktop — reuses same tool handlers
  console.error("[mcp] stdio mode not yet wired, HTTP mode active");
}
