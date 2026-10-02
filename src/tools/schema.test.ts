import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toolParametersToJsonSchema } from "./schema.js";
import { ToolRegistry } from "./registry.js";

test("toolParametersToJsonSchema: converts Zod v4 schemas into JSON Schema", () => {
  const schema = z.object({
    path: z.string().describe("a path"),
    count: z.coerce.number().int().min(1).default(1),
  });

  const json = toolParametersToJsonSchema(schema);
  assert.deepEqual(Object.keys(json.properties), ["path", "count"]);
  assert.equal(json.properties.path.type, "string");
  // Unsupported keywords are stripped before the schema reaches a model API.
  assert.equal(json.properties.count.default, undefined);
});

test("toolParametersToJsonSchema: every registered tool declares its parameters", () => {
  const registry = new ToolRegistry();

  for (const tool of registry.getAll()) {
    const json = toolParametersToJsonSchema(tool.parameters);
    assert.equal(json.type, "object", `${tool.name} should produce an object schema`);
    assert.ok(
      Object.keys(json.properties || {}).length > 0,
      `${tool.name} should declare at least one parameter`,
    );
  }
});
