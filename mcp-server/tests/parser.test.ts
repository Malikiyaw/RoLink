import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tools } from "../src/tools/registry.js";
import parser from "../../rolink-extension/core/parser.js";

const parse = parser as typeof import("../../rolink-extension/core/parser.js");

describe("RoLink tool parser", () => {
  it("parses normal MCP JSON", () => {
    const result = parse.extract(`###MCP_TOOL###\n{"tool":"get_instances","args":{"path":"workspace"}}`);
    expect(result).toMatchObject({ tool: "get_instances", args: { path: "workspace" }, repaired: false });
  });

  it("repairs unescaped quotes and raw newlines in any string field", () => {
    const result = parse.extract(`###MCP_TOOL###\n{"tool":"set_script_content","args":{"path":"Workspace/Script","content":"local p = Instance.new(\"Part\")\np.Name = \"Hello\""}}`);
    expect(result?.tool).toBe("set_script_content");
    expect(result?.args.content).toContain('Instance.new("Part")');
    expect(result?.args.content).toContain('p.Name = "Hello"');
    expect(result?.repaired).toBe(true);
  });

  it("salvages a cut-off object only when the string is complete", () => {
    const result = parse.extract(`###MCP_TOOL###\n{"tool":"create_instance","args":{"className":"Part","name":"Crate"`);
    expect(result).toMatchObject({ tool: "create_instance", args: { className: "Part", name: "Crate" } });

    const truncated = parse.extract(`###MCP_TOOL###\n{"tool":"execute_luau","args":{"code":"print(\"still typing`);
    expect(truncated).toBeNull();
  });

  it("supports the raw-field escape hatch without JSON escaping", () => {
    const result = parse.extract(`###MCP_TOOL###\n{"tool":"set_script_content","args":{"path":"Workspace/Script"}}\n###RAW:content###\nlocal part = Instance.new("Part")\npart.Parent = workspace\n###END_RAW###`);
    expect(result).toMatchObject({
      tool: "set_script_content",
      args: { path: "Workspace/Script" },
      rawFields: { content: 'local part = Instance.new("Part")\npart.Parent = workspace' },
    });
    expect(result?.args.content).toContain('Instance.new("Part")');
  });

  it("supports command/params and bare function-call shapes", () => {
    expect(parse.extract('```json\n{"command":"get_instances","params":{"path":"workspace"}}\n```')).toMatchObject({
      tool: "get_instances", args: { path: "workspace" }
    });
    expect(parse.extract('{"tool":"find_instance","args":{"query":"SpawnLocation"}}')).toMatchObject({
      tool: "find_instance", args: { query: "SpawnLocation" }
    });
  });

  it("does not regress the 111-tool catalog", () => {
    expect(tools.length).toBeGreaterThanOrEqual(111);
    for (const tool of tools) {
      const fixture = `###MCP_TOOL###\n${JSON.stringify({ tool: tool.name, args: {} })}`;
      const result = parse.extract(fixture);
      expect(result?.tool, `failed parsing ${tool.name}`).toBe(tool.name);
    }
  });

  it("keeps the checked-in fixture corpus present", () => {
    const fixtureDir = new URL("../../rolink-extension/core/__fixtures__/tool-calls/", import.meta.url);
    const fsPath = fixtureDir.pathname.replace(/^\//, "").replace(/^([A-Za-z]):/, "$1:");
    // The bootstrap corpus is intentionally small; the generator below produces one fixture per registry tool.
    expect(readFileSync(`${fsPath}README.txt`, "utf8")).toContain("generate-tool-fixtures");
  });
});
