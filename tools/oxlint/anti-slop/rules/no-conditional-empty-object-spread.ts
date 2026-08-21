import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Removes all outer parenthesized expression wrappers from an expression.
 *
 * @param node - The expression to unwrap
 * @returns The innermost expression after removing surrounding parentheses
 */
function unwrapParentheses(node: ESTree.Expression): ESTree.Expression {
  let current = node;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

/**
 * Determines whether an expression is an empty object literal.
 *
 * @returns `true` if the expression is an object literal with no properties, `false` otherwise.
 */
function isEmptyObjectExpression(node: ESTree.Expression): boolean {
  return node.type === "ObjectExpression" && node.properties.length === 0;
}

/**
 * Determines whether an expression conditionally includes an empty object.
 *
 * @param node - The expression to inspect
 * @returns `true` if the expression is a conditional expression with an empty object branch, `false` otherwise
 */
function isConditionalEmptyObjectSpread(node: ESTree.Expression): boolean {
  const conditional = unwrapParentheses(node);
  return (
    conditional.type === "ConditionalExpression" &&
    (isEmptyObjectExpression(conditional.consequent) ||
      isEmptyObjectExpression(conditional.alternate))
  );
}

/** Ban conditional empty-object spreads without changing their omission semantics. */
export const noConditionalEmptyObjectSpreadRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow object spreads that conditionally spread an empty object to omit fields.",
    },
    messages: {
      avoid:
        "This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present.",
    },
  },
  createOnce(context) {
    return {
      SpreadElement(node) {
        if (node.parent.type !== "ObjectExpression") return;

        if (isConditionalEmptyObjectSpread(node.argument)) {
          context.report({ node, messageId: "avoid" });
        }
      },
    };
  },
});
