import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

/**
 * Determines whether a symbol name contains the forbidden term.
 *
 * @param name - The symbol name to check
 * @returns `true` if the name contains the forbidden term, `false` otherwise.
 */
function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
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
      if (!containsForbiddenSymbolName(node.name)) return;
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
