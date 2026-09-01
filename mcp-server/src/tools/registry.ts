import { z } from "zod";
import { commandQueue } from "../commandQueue.js";
import { isToolAllowed, sanitizeCode } from "../security/policy.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
};

function queueAndWait(tool: string, command: string, args: Record<string, unknown>, timeoutMs = 15000) {
  if (!isToolAllowed(tool)) throw new Error(`tool not allowed: ${tool}`);
  const cmd = commandQueue.enqueue({ tool, command, args, timeoutMs });
  return { id: cmd.id, enqueued: cmd };
}

export const tools: ToolDef[] = [
  {
    name: "create_instance",
    description: "Create a Roblox instance. Use after checking snapshot. Returns queued id, plugin will create Instance.new.",
    inputSchema: z.object({ className: z.string().describe("Roblox class e.g., Part, Script"), parent: z.string().default("workspace").describe("Parent path"), name: z.string().optional(), properties: z.record(z.unknown()).optional() }),
    handler: async (args) => {
      const { id } = queueAndWait("create_instance", `Instance.new("${args.className}")`, args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id, tool: "create_instance", args }) }] };
    }
  },
  {
    name: "run_code",
    description: "Execute Luau code in Studio plugin sandbox (wrapped with HistoryService waypoint). Code is sanitized.",
    inputSchema: z.object({ code: z.string().describe("Luau code to execute"), timeoutMs: z.number().optional() }),
    handler: async (args) => {
      const code = sanitizeCode(args.code);
      const { id } = queueAndWait("run_code", code, args, args.timeoutMs);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id, tool: "run_code", codePreview: code.slice(0, 200) }) }] };
    }
  },
  {
    name: "get_snapshot",
    description: "Request a snapshot of current game hierarchy from Studio plugin.",
    inputSchema: z.object({ maxDepth: z.number().optional(), filter: z.string().optional() }),
    handler: async (args) => {
      const { id } = queueAndWait("get_snapshot", "--snapshot", args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id }) }] };
    }
  },
  {
    name: "get_logs",
    description: "Get team log / recent command results.",
    inputSchema: z.object({ limit: z.number().optional().default(20) }),
    handler: async (args) => {
      const s = commandQueue.status();
      return { content: [{ type: "text", text: JSON.stringify({ ...s, limit: args.limit }, null, 2) }] };
    }
  },
  {
    name: "set_property",
    description: "Set property on instance.",
    inputSchema: z.object({ path: z.string(), property: z.string(), value: z.unknown() }),
    handler: async (args) => {
      const { id } = queueAndWait("set_property", `${args.path}.${args.property}=...`, args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id }) }] };
    }
  },
  {
    name: "undo",
    description: "Undo last change via HistoryService waypoint.",
    inputSchema: z.object({ steps: z.number().optional().default(1) }),
    handler: async (args) => {
      const { id } = queueAndWait("undo", "--undo", args);
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, id }) }] };
    }
  },
];
