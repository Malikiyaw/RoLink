import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { tools } from "../mcp-server/src/tools/registry.js";

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    const typeName = (current as any)?._def?.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
        typeName === z.ZodFirstPartyTypeKind.ZodNullable ||
        typeName === z.ZodFirstPartyTypeKind.ZodDefault ||
        typeName === z.ZodFirstPartyTypeKind.ZodBranded ||
        typeName === z.ZodFirstPartyTypeKind.ZodCatch ||
        typeName === z.ZodFirstPartyTypeKind.ZodReadonly) {
      current = (current as any)._def.innerType ?? (current as any)._def.type;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
      current = (current as any)._def.schema;
      continue;
    }
    return current;
  }
}

function isString(schema: z.ZodTypeAny): boolean {
  return unwrap(schema)?._def?.typeName === z.ZodFirstPartyTypeKind.ZodString;
}

function codeLike(name: string): boolean {
  return /(?:code|content|source|script|text|string|handler|exports|prompt|query|description|label|message|expression|command)$/i.test(name);
}

function collect(schema: z.ZodTypeAny, prefix = "", out = new Set<string>()): Set<string> {
  const u = unwrap(schema);
  const typeName = (u as any)?._def?.typeName;
  if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const shape = (u as z.AnyZodObject)._def.shape();
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const unwrapped = unwrap(child as z.ZodTypeAny);
      if (isString(unwrapped)) out.add(path);
      else collect(unwrapped, path, out);
    }
  } else if (typeName === z.ZodFirstPartyTypeKind.ZodArray || typeName === z.ZodFirstPartyTypeKind.ZodSet) {
    collect((u as any)._def.type, `${prefix}[]`, out);
  } else if (typeName === z.ZodFirstPartyTypeKind.ZodRecord) {
    collect((u as any)._def.valueType, `${prefix}{}`, out);
  } else if (typeName === z.ZodFirstPartyTypeKind.ZodUnion || typeName === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
    for (const option of (u as any)._def.options ?? (u as any)._def.optionsMap?.values?.() ?? []) collect(option, prefix, out);
  }
  return out;
}

export async function generateCodeFields(): Promise<void> {
  const toolFields: Record<string, string[]> = {};
  const stringFields = new Set<string>();
  for (const tool of tools) {
    const fields = [...collect(tool.inputSchema)].sort();
    toolFields[tool.name] = fields;
    for (const field of fields) stringFields.add(field.split(".").pop()!.replace(/\[\]$|\{\}$/g, ""));
  }

  const result = {
    version: 2,
    source: "mcp-server/src/tools/registry.ts",
    generatedAt: new Date().toISOString(),
    toolCount: tools.length,
    toolFields,
    stringFields: [...stringFields].sort(),
    codeLikeFields: [...stringFields].filter(codeLike).sort(),
  };

  await mkdir("generated", { recursive: true });
  await writeFile("generated/code-fields.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`generated/code-fields.json: ${tools.length} tools, ${stringFields.size} string field names`);
}
