import { makeId, type QueuedCommand, type EnqueuePayload } from "../../shared/protocol.js";

const MAX_QUEUE = 200;
const CLAIM_TIMEOUT_MS = 30000;

class CommandQueue {
  private queue: QueuedCommand[] = [];
  private byId = new Map<string, QueuedCommand>();
  private pendingResults = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();

  enqueue(payload: EnqueuePayload): QueuedCommand {
    if (this.queue.filter(c => c.status === "queued").length >= MAX_QUEUE) {
      throw new Error("503 queue full (max 200)");
    }
    const cmd: QueuedCommand = {
      id: makeId(),
      status: "queued",
      attempts: 0,
      createdAt: Date.now(),
      command: payload.command,
      tool: payload.tool,
      args: payload.args ?? {},
      priority: payload.priority ?? 5,
      timeoutMs: payload.timeoutMs ?? 15000,
      projectId: payload.projectId ?? "default",
    };
    // insert by priority descending
    let idx = this.queue.findIndex(c => c.status === "queued" && (c.priority ?? 5) < (cmd.priority ?? 5));
    if (idx === -1) this.queue.push(cmd);
    else this.queue.splice(idx, 0, cmd);
    this.byId.set(cmd.id, cmd);
    return cmd;
  }

  next(projectId?: string): QueuedCommand | null {
    // reclaim timed out claims
    const now = Date.now();
    for (const c of this.queue) {
      if (c.status === "claimed" && c.claimedAt && now - c.claimedAt > CLAIM_TIMEOUT_MS) {
        c.status = "queued";
        c.attempts += 1;
      }
    }
    const candidate = this.queue.find(c => c.status === "queued" && (!projectId || c.projectId === projectId));
    if (!candidate) return null;
    candidate.status = "claimed";
    candidate.claimedAt = now;
    candidate.attempts += 1;
    return candidate;
  }

  complete(id: string, result: unknown, error?: string): QueuedCommand | null {
    const cmd = this.byId.get(id);
    if (!cmd) return null;
    cmd.status = error ? "failed" : "done";
    cmd.result = result;
    cmd.error = error;
    // resolve pending waiter if any
    const waiter = this.pendingResults.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve(result);
      this.pendingResults.delete(id);
    }
    return cmd;
  }

  get(id: string): QueuedCommand | undefined {
    return this.byId.get(id);
  }

  status(projectId?: string) {
    const filtered = projectId ? this.queue.filter(c => c.projectId === projectId) : this.queue;
    return {
      depth: filtered.filter(c => c.status === "queued").length,
      claimed: filtered.filter(c => c.status === "claimed").length,
      done: filtered.filter(c => c.status === "done").length,
      failed: filtered.filter(c => c.status === "failed").length,
      total: filtered.length,
      items: filtered.slice(-20).reverse(),
    };
  }

  waitForResult(id: string, timeoutMs: number): Promise<unknown> {
    const cmd = this.byId.get(id);
    if (!cmd) return Promise.reject(new Error("not found"));
    if (cmd.status === "done") return Promise.resolve(cmd.result);
    if (cmd.status === "failed") return Promise.reject(new Error(cmd.error));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(id);
        reject(new Error("timeout waiting for plugin result"));
      }, timeoutMs);
      // NodeJS Timeout needs unref in some contexts
      if (typeof (timer as any).unref === "function") (timer as any).unref();
      this.pendingResults.set(id, { resolve, reject, timer });
    });
  }

  clearDone(olderThanMs = 60000) {
    const cutoff = Date.now() - olderThanMs;
    this.queue = this.queue.filter(c => !(c.status === "done" && c.createdAt < cutoff));
    for (const [k, v] of this.byId) if (v.status === "done" && v.createdAt < cutoff) this.byId.delete(k);
  }
}

export const commandQueue = new CommandQueue();
setInterval(() => commandQueue.clearDone(), 60000).unref?.();
