import { parse } from "acorn";
import { simple } from "acorn-walk";
import { parseDocument } from "yaml";
import { Type } from "typebox";
import { Check } from "typebox/value";

const schema = Type.Union([
  Type.Object({
    openapi: Type.String({ pattern: "^3\\.\\d+\\.\\d+$" }),
    info: Type.Object({}),
    paths: Type.Object({}),
  }),
  Type.Object({ swagger: Type.Literal("2.0"), info: Type.Object({}), paths: Type.Object({}) }),
]);

// Parsing is synchronous and untrusted. Larger inputs remain readable without classification.
const MAX_CLASSIFICATION_CHARACTERS = 512 * 1024;

/** Conservatively recognizes a document or a literal object embedded in JavaScript. Never executes source. */
export function isOpenapiSource(raw: string, contentType: string): boolean {
  if (raw.length > MAX_CLASSIFICATION_CHARACTERS) return false;

  try {
    if (contentType === "application/json") return Check(schema, JSON.parse(raw));

    if (contentType === "text/yaml") {
      const document = parseDocument(raw, { uniqueKeys: true });

      return document.errors.length === 0 && Check(schema, document.toJS({ maxAliasCount: 0 }));
    }

    if (contentType !== "text/javascript") return false;
    const ast = parse(raw, { ecmaVersion: "latest", sourceType: "module" });
    let found = false;
    simple(ast, {
      ObjectExpression(node) {
        let version = false;
        let info = false;
        let paths = false;

        for (const property of node.properties) {
          if (property.type !== "Property" || property.computed || property.kind !== "init")
            continue;

          const key =
            property.key.type === "Identifier"
              ? property.key.name
              : property.key.type === "Literal"
                ? property.key.value
                : undefined;

          if ((key === "openapi" || key === "swagger") && property.value.type === "Literal") {
            const value = property.value.value;
            version ||=
              key === "swagger"
                ? value === "2.0"
                : Check(Type.String({ pattern: "^3\\.\\d+\\.\\d+$" }), value);
          }

          if (key === "info" && property.value.type === "ObjectExpression") info = true;

          if (key === "paths" && property.value.type === "ObjectExpression") paths = true;
        }

        if (version && info && paths) found = true;
      },
    });

    return found;
  } catch {
    return false;
  }
}

/** Reconstructs detection from older cached canonical representations, without a network request. */
export function isCachedOpenapi(markdown: string, contentType: string): boolean {
  const match = /^```(?:json|js|yaml)\r?\n([\s\S]*)\r?\n```\s*$/.exec(markdown);

  return isOpenapiSource(match ? match[1] : markdown, contentType);
}
