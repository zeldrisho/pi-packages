import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * Finds the variable definition visible from an identifier's lexical scope.
 *
 * @param identifier - The identifier whose variable definition to resolve
 * @returns The resolved variable, or `null` when no definition is found
 */
function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * Determines whether an expression refers to the global, unshadowed `Reflect` object.
 *
 * @param sourceCode - The source code context used to resolve the expression
 * @param expression - The expression to inspect
 * @returns `true` if the expression refers to global `Reflect`, `false` otherwise
 */
function isGlobalReflect(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type !== "Identifier" || expression.name !== "Reflect") return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0;
}

/**
 * Determines whether a call target refers to a specified method on the global `Reflect` object.
 *
 * @param callee - The call target to inspect
 * @param methodName - The method name to match
 * @returns `true` if the call target names the specified global `Reflect` method, `false` otherwise.
 */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;
  if (!isGlobalReflect(sourceCode, callee.object)) return false;
  const property = callee.property;
  return callee.computed
    ? property.type === "Literal" && property.value === methodName
    : property.type === "Identifier" && property.name === methodName;
}
