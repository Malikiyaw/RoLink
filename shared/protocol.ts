/**
 * RoLink Wire Protocol v1 — shared between extension, bridge, MCP, plugin
 * Snake_case WireMethod, id-correlated JSON frames
 */
export const PROTOCOL_VERSION = 1;

export type Role = "extension" | "plugin" | "mcp";

export type WireMethod =
  | "hello"
  | "enqueue_command"
  | "poll_next"
  | "command_result"
  | "heartbeat"
  | "error"
  | "call_tool"
  | "tool_result"
  | "tool_event"
  | "list_tools"
  | "studio_status";

export interface WireFrame {
  v: number; // protocol version
  id: string; // uuid correlation
  method: WireMethod;
  role?: Role;
  token?: string;
  payload?: unknown;
  ts?: number;
}

export interface ToolEventMeta {
  eventId?: string; // queue command id (minted at enqueue)
  category?: ToolCategory; // HUD color/icon family
  sessionId?: string | null;
}

export interface EnqueuePayload {
  command: string; // Luau code or DSL
  tool: string; // e.g., "create_instance", "run_code"
  args?: Record<string, unknown>;
  priority?: number; // 0-10
  timeoutMs?: number;
  projectId?: string;
  meta?: ToolEventMeta; // P3: Studio HUD correlation (optional, server fills defaults)
}

export interface QueuedCommand extends EnqueuePayload {
  id: string;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  createdAt: number;
  claimedAt?: number;
  result?: unknown;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  version: number;
  uptime: number;
  queueDepth: number;
  wsClients: number;
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export type BridgeState =
  | "BRIDGE_OFFLINE"
  | "MCP_OFFLINE"
  | "STUDIO_OFFLINE"
  | "STUDIO_NO_PLACE"
  | "STUDIO_READY";

export interface CallToolFrame {
  type: "call_tool";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  timeout?: number;
  sessionId?: string;
  turnId?: string;
}

export interface ToolResultFrame {
  type: "tool_result";
  id: string;
  ok: boolean;
  kind?: string;
  text?: string;
  error?: string;
  images?: Array<{data:string,mimeType:string}>;
}

export function isValidFrame(o: unknown): o is WireFrame {
  if (!o || typeof o !== "object") return false;
  const f = o as WireFrame;
  return typeof f.v === "number" && typeof f.id === "string" && typeof f.method === "string";
}

export function makeExecutionId(): string {
  return `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
}

// Unified tool catalogue entry (provider abstraction for AI)
export interface UnifiedToolEntry {
  name: string;
  description: string;
  provider: "roblox" | "rolink";
  execution: "studio" | "local";
}

// ── P0 ToolEvent spine ──────────────────────────────────────────────
// Emitted by the extension (parser → queued, execution → running →
// terminal) and re-broadcast by bridge.py to all connected tabs.
// UI (SideDock / Timeline / Studio HUD) subscribes; the agent loop
// never blocks on it. Category reuses the extension's 8 toolCategory()
// values so prompts, registry and HUD stay in sync.
export type ToolStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "waiting"
  | "timeout"
  | "cancelled"
  | "stale";

export type ToolCategory =
  | "read"
  | "edit"
  | "inspect"
  | "generate"
  | "asset"
  | "visual"
  | "test"
  | "tool";

export interface ToolEvent {
  id: string;
  tool: string;
  category: ToolCategory;
  status: ToolStatus;
  args: Record<string, unknown>;
  result?: unknown;
  startTime: number;
  durationMs?: number;
  previewUrl?: string;
  codeDiff?: { before: string; after: string };
  sessionId?: string | null;
  turnId?: string | null;
}

export interface ToolEventFrame {
  type: "tool_event";
  id: string;
  event: ToolEvent;
}
