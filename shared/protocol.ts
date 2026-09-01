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
  | "error";

export interface WireFrame {
  v: number; // protocol version
  id: string; // uuid correlation
  method: WireMethod;
  role?: Role;
  token?: string;
  payload?: unknown;
  ts?: number;
}

export interface EnqueuePayload {
  command: string; // Luau code or DSL
  tool: string; // e.g., "create_instance", "run_code"
  args?: Record<string, unknown>;
  priority?: number; // 0-10
  timeoutMs?: number;
  projectId?: string;
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

export function isValidFrame(o: unknown): o is WireFrame {
  if (!o || typeof o !== "object") return false;
  const f = o as WireFrame;
  return typeof f.v === "number" && typeof f.id === "string" && typeof f.method === "string";
}
