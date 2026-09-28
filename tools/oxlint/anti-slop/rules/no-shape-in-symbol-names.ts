import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Return whether an identifier names a statically accessed member owned by another value. */
function isBorrowedMemberName(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === "MemberExpression") {
    return parent.property === node && parent.computed === false;
  }
  if (parent.type === "ImportSpecifier") {
    return (
      parent.imported.type === "Identifier" &&
      parent.imported === node &&
      parent.local.name !== parent.imported.name
    );
  }
  if (parent.type !== "ExportSpecifier") return false;
  const declaration = parent.parent;
  return (
    (parent.local === node || parent.exported === node) &&
    declaration.type === "ExportNamedDeclaration" &&
    declaration.source !== null &&
    declaration.source !== undefined
  );
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name) || isBorrowedMemberName(node)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
