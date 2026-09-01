/**
 * S10 AI Training on Your Codebase — stylometry from command history to personalize code style
 */
import { commandQueue } from "./commandQueue.js";

export interface StyleProfile {
  projectId: string;
  avgLineLength: number;
  usesWaitForChild: boolean;
  usesCamelCase: boolean;
  indent: string; // "\t" or "  "
  commonPatterns: string[];
  sampleCount: number;
}

class AiTraining {
  profile(projectId = "default"): StyleProfile {
    const items = commandQueue.status(projectId).items.slice(0, 50);
    const codes = items.map(i=> i.command).join("\n");
    const lines = codes.split("\n").filter(Boolean);
    const avgLineLength = lines.length ? lines.reduce((s,l)=> s + l.length,0)/lines.length : 0;
    const usesWaitForChild = codes.includes("WaitForChild");
    const usesCamelCase = /[a-z]+[A-Z]/.test(codes);
    const indent = codes.includes("\t") ? "\t" : "  ";
    const patterns: string[] = [];
    if (codes.includes("Instance.new")) patterns.push("Instance.new");
    if (codes.includes(":Connect")) patterns.push(":Connect");
    if (codes.includes("leaderstats")) patterns.push("leaderstats");
    return { projectId, avgLineLength: Math.round(avgLineLength*10)/10, usesWaitForChild, usesCamelCase, indent, commonPatterns: patterns, sampleCount: items.length };
  }

  personalize(code: string, projectId = "default"): string {
    const p = this.profile(projectId);
    let out = code;
    // enforce indent style
    if (p.indent === "\t") out = out.replace(/ {2}/g, "\t");
    else out = out.replace(/\t/g, "  ");
    // if user prefers WaitForChild, ensure usage
    if (p.usesWaitForChild && !out.includes("WaitForChild") && out.includes("FindFirstChild")) {
      out = out.replace(/FindFirstChild\("([^"]+)"\)/g, 'WaitForChild("$1")');
    }
    return out;
  }

  // training is implicit from history; export dataset for future LLM fine-tune
  exportDataset(projectId = "default") {
    const items = commandQueue.status(projectId).items;
    return items.map(i=> ({ prompt: i.tool, completion: i.command, projectId }));
  }
}

export const aiTraining = new AiTraining();
