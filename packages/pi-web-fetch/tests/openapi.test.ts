import { describe, expect, it } from "vite-plus/test";
import { isCachedOpenapi, isOpenapiSource } from "../src/document/openapi.ts";

describe("OpenAPI source detection", () => {
  it("detects JSON, YAML, and embedded JavaScript object literals", () => {
    expect(isOpenapiSource('{"openapi":"3.1.0","info":{},"paths":{}}', "application/json")).toBe(
      true,
    );
    expect(isOpenapiSource('swagger: "2.0"\ninfo: {}\npaths: {}\n', "text/yaml")).toBe(true);
    expect(
      isOpenapiSource('export const spec = {openapi:"3.1.0",info:{},paths:{}};', "text/javascript"),
    ).toBe(true);
  });
  it("rejects strings, incomplete objects, aliases and oversized inputs", () => {
    expect(isOpenapiSource('const x = "openapi: 3.1.0 info paths";', "text/javascript")).toBe(
      false,
    );
    expect(isOpenapiSource('{"openapi":"3.1.0","info":{}}', "application/json")).toBe(false);
    expect(isOpenapiSource("openapi: 3.1.0\ninfo: &x {}\npaths: *x", "text/yaml")).toBe(false);
    expect(isOpenapiSource(" ".repeat(512 * 1024 + 1), "text/yaml")).toBe(false);
    expect(
      isOpenapiSource('const x = {openapi:"3.1.0",info:{},paths:{}}', "application/json"),
    ).toBe(false);
  });
  it("recognizes old cached fenced documents", () => {
    expect(
      isCachedOpenapi('```json\n{"swagger":"2.0","info":{},"paths":{}}\n```', "application/json"),
    ).toBe(true);
  });
});
