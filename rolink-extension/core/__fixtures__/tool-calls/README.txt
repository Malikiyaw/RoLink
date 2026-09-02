Parser fixture corpus.

Run `npx tsx scripts/generate-tool-fixtures.ts` from the repository root to regenerate one .txt fixture per registered tool in mcp-server/src/tools/registry.ts.

The committed regression suite covers the malformed/repair/salvage/raw-block edge cases directly and separately checks every registered tool name against a canonical MCP fixture.
