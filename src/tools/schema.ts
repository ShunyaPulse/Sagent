import { z } from "zod";

/**
 * Keywords that the Gemini function-declaration schema does not define and that
 * should be stripped before the schema is sent to a model API.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "default",
  "additionalProperties",
]);

function sanitize(node: any): any {
  if (Array.isArray(node)) {
    return node.map(sanitize);
  }
  if (node && typeof node === "object") {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.has(key)) continue;
      out[key] = sanitize(value);
    }
    return out;
  }
  return node;
}

/**
 * Converts a tool's Zod (v4) parameter schema into a JSON Schema object.
 *
 * Uses Zod's native converter rather than zod-to-json-schema because that
 * package only supports Zod v3 and silently returns an empty schema for Zod v4
 * definitions, which left every tool with no declared parameters.
 */
export function toolParametersToJsonSchema(
  schema: z.ZodTypeAny,
): Record<string, any> {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, any>;

  return sanitize(jsonSchema);
}
