import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import {
  CONFIG_SCHEMA_URL,
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_PROMPT_TIMEOUT_MS,
  MAX_RULE_COUNT,
  MAX_RULE_PATTERN_LENGTH,
} from "../src/index";

interface GateConfigSchema {
  $id: string;
  required: string[];
  properties: {
    promptTimeoutMs: { default: number; maximum: number };
    operations: {
      maxProperties: number;
      propertyNames: { minLength: number; maxLength: number };
      additionalProperties: { enum: string[] };
    };
  };
}

async function loadSchema(): Promise<GateConfigSchema> {
  const source = await readFile(new URL("../config.schema.json", import.meta.url), "utf8");
  // SAFETY: this test immediately asserts the schema fields consumed through this local shape.
  return JSON.parse(source) as GateConfigSchema;
}

describe("pi-gate config schema", () => {
  it("describes the runtime configuration limits and actions", async () => {
    const schema = await loadSchema();

    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
    expect(schema.required).toContain("operations");
    expect(schema.properties.promptTimeoutMs.default).toBe(DEFAULT_PROMPT_TIMEOUT_MS);
    expect(schema.properties.promptTimeoutMs.maximum).toBe(MAX_PROMPT_TIMEOUT_MS);
    expect(schema.properties.operations.maxProperties).toBe(MAX_RULE_COUNT);
    expect(schema.properties.operations.propertyNames).toEqual({
      minLength: 1,
      maxLength: MAX_RULE_PATTERN_LENGTH,
    });
    expect(schema.properties.operations.additionalProperties.enum).toEqual([
      "prompt",
      "block",
      "allow",
    ]);
  });
});
