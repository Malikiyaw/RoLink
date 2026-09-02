import { mkdir, writeFile } from "node:fs/promises";
import { tools } from "../mcp-server/src/tools/registry.ts";

const dir = "rolink-extension/core/__fixtures__/tool-calls";
await mkdir(dir, { recursive: true });
for (const tool of tools) {
  const safe = tool.name.replace(/[^A-Za-z0-9_.-]/g, "_");
  const payload = { tool: tool.name, args: {} };
  const text = `###MCP_TOOL###\n${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(`${dir}/${safe}.txt`, text, "utf8");
}
console.log(`generated ${tools.length} parser fixtures in ${dir}`);
