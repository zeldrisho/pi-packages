import { defineRule } from "@oxlint/plugins";
import type { ESTree, Variable } from "@oxlint/plugins";

type BroadTypeKind = "top" | "object" | "record";

type KnownValueEvidence = {
  readonly type: ESTree.TSType | null;
};

const functionBoundaryTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

/**
 * Removes enclosing parentheses from an expression.
 *
 * @param expression - The expression to unwrap
 * @returns The innermost expression after removing enclosing parentheses
 */
function unwrapExpressionParentheses(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

/**
 * Removes surrounding parentheses from a TypeScript type.
 *
 * @param type - The type to unwrap
 * @returns The underlying type without surrounding parentheses
 */
function unwrapTypeParentheses(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current;
}

/**
 * Gets the name of a type reference when it uses an identifier.
 *
 * @param type - The type reference to inspect
 * @returns The referenced identifier name, or `null` for other type-name forms
 */
function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

/**
 * Determines whether a type represents `unknown` or `any`.
 *
 * @param type - The type to inspect.
 * @returns `true` if the type is `unknown` or `any`, `false` otherwise.
 */
function isUnknownOrAnyType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

/**
 * Determines whether a type represents a broad record key.
 *
 * @param type - The type to inspect
 * @returns `true` if the type is a string, number, symbol, `PropertyKey`, or a union of these types, `false` otherwise.
 */
function isBroadRecordKeyType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") return unwrapped.types.every(isBroadRecordKeyType);
  return unwrapped.type === "TSTypeReference" && typeReferenceName(unwrapped) === "PropertyKey";
}

/**
 * Determines whether a type is a broad record with string-, number-, symbol-, or `PropertyKey`-based keys and `unknown` or `any` values.
 *
 * @param type - The type to inspect
 * @returns `true` if the type is a broad record, including a `Readonly` wrapper around one, `false` otherwise.
 */
function isBroadRecordType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);

  if (unwrapped.type === "TSTypeReference") {
    if (typeReferenceName(unwrapped) === "Readonly") {
      const [inner] = unwrapped.typeArguments?.params ?? [];
      return inner !== undefined && isBroadRecordType(inner);
    }

    if (typeReferenceName(unwrapped) !== "Record") return false;
    const parameters = unwrapped.typeArguments?.params ?? [];
    return (
      parameters.length === 2 &&
      parameters[0] !== undefined &&
      parameters[1] !== undefined &&
      isBroadRecordKeyType(parameters[0]) &&
      isUnknownOrAnyType(parameters[1])
    );
  }

  if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) return false;
  const [member] = unwrapped.members;
  const [parameter] = member?.type === "TSIndexSignature" ? member.parameters : [];
  return (
    member?.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    parameter !== undefined &&
    isBroadRecordKeyType(parameter.typeAnnotation.typeAnnotation) &&
    isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
  );
}

/**
 * Classifies a type as a top type, object type, broad record type, or unsupported type.
 *
 * @param type - The TypeScript type to classify
 * @returns The broad type category, or `null` when the type is not broad
 */
function broadTypeKind(type: ESTree.TSType): BroadTypeKind | null {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword") return "top";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  return isBroadRecordType(unwrapped) ? "record" : null;
}

/**
 * Extracts the asserted expression from a TypeScript assertion node.
 *
 * @param node - The TypeScript `as` expression or type assertion to inspect
 * @returns The underlying expression with surrounding parentheses removed
 */
function assertedExpression(
  node: ESTree.TSAsExpression | ESTree.TSTypeAssertion,
): ESTree.Expression {
  return unwrapExpressionParentheses(node.expression);
}

/**
 * Retrieves a type assertion from an expression after removing parentheses.
 *
 * @param expression - The expression to inspect
 * @returns The contained `TSAsExpression` or `TSTypeAssertion`, or `null` if the expression is not a type assertion
 */
function assertionFromExpression(
  expression: ESTree.Expression,
): ESTree.TSAsExpression | ESTree.TSTypeAssertion | null {
  const unwrapped = unwrapExpressionParentheses(expression);
  return unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion"
    ? unwrapped
    : null;
}

/**
 * Produces a whitespace-normalized representation of a TypeScript type node.
 *
 * @param sourceText - The source text containing the type node
 * @param type - The type node whose source text is normalized
 * @returns The type text with whitespace removed
 */
function normalizedTypeText(sourceText: string, type: ESTree.TSType): string {
  return sourceText.slice(type.start, type.end).replaceAll(/\s+/gu, "");
}

/**
 * Determines whether two type nodes have equivalent normalized syntax.
 *
 * @param sourceText - The source text used to normalize the type nodes
 * @param left - The first type node, if available
 * @param right - The second type node
 * @returns `true` if both type nodes have equivalent normalized syntax, `false` otherwise
 */
function typesHaveSameSyntax(
  sourceText: string,
  left: ESTree.TSType | null,
  right: ESTree.TSType,
): boolean {
  return (
    left !== null &&
    normalizedTypeText(sourceText, unwrapTypeParentheses(left)) ===
      normalizedTypeText(sourceText, unwrapTypeParentheses(right))
  );
}

/**
 * Determines whether a TypeScript type is definitively object-shaped.
 *
 * @param type - The type to inspect
 * @returns `true` if the type is definitively object-shaped, `false` otherwise.
 */
function isDefinitelyObjectType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  switch (unwrapped.type) {
    case "TSArrayType":
    case "TSConstructorType":
    case "TSFunctionType":
    case "TSMappedType":
    case "TSObjectKeyword":
    case "TSTupleType":
      return true;
    case "TSTypeLiteral":
      return unwrapped.members.length > 0;
    case "TSIntersectionType":
      return unwrapped.types.every(isDefinitelyObjectType);
    case "TSTypeOperator":
      return unwrapped.operator === "readonly" && isDefinitelyObjectType(unwrapped.typeAnnotation);
    default:
      return false;
  }
}

/**
 * Determines whether a type describes a record with known, narrower value information.
 *
 * @param type - The type to inspect
 * @returns `true` if the type has explicit properties or a `Record` value type other than `unknown` or `any`, `false` otherwise.
 */
function isDefinitelyNarrowerRecordType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type !== "TSIndexSignature");
  }

  if (unwrapped.type !== "TSTypeReference") return false;
  if (typeReferenceName(unwrapped) === "Readonly") {
    const [inner] = unwrapped.typeArguments?.params ?? [];
    return inner !== undefined && isDefinitelyNarrowerRecordType(inner);
  }
  if (typeReferenceName(unwrapped) !== "Record") return false;

  const parameters = unwrapped.typeArguments?.params ?? [];
  return (
    parameters.length === 2 && parameters[1] !== undefined && !isUnknownOrAnyType(parameters[1])
  );
}

/**
 * Finds the nearest enclosing function boundary for a node.
 *
 * @param node - The node whose enclosing function boundary is sought
 * @returns The nearest enclosing function node, or `null` when the node is at program scope
 */
function functionBoundary(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (functionBoundaryTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Resolves an identifier reference to its associated variable.
 *
 * @param scopes - Scopes containing identifier references and their resolved variables
 * @param identifier - The identifier reference to resolve
 * @returns The associated variable, or `null` when no matching resolution exists
 */
function resolvedVariableForIdentifier(
  scopes: readonly {
    readonly references: readonly {
      readonly identifier: ESTree.Node;
      readonly resolved: Variable | null;
    }[];
  }[],
  identifier: ESTree.IdentifierReference,
): Variable | null {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        candidate.identifier.start === identifier.start &&
        candidate.identifier.end === identifier.end,
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

/**
 * Finds the variable declarator associated with a variable.
 *
 * @param variable - The variable whose declaration to locate
 * @returns The associated variable declarator, or `null` if none exists
 */
function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
      return definition.node;
    }
  }
  return null;
}

/**
 * Determines whether an expression provides a known, narrower type or value-shape evidence.
 *
 * @param expression - The expression to inspect.
 * @param boundary - The function or program scope in which referenced bindings must be resolved.
 * @returns Evidence describing the known type or value shape, or `null` when no usable evidence is available.
 */
function knownValueEvidence(
  expression: ESTree.Expression,
  scopes: Parameters<typeof resolvedVariableForIdentifier>[0],
  boundary: ESTree.Node | null,
  visitedVariables: ReadonlySet<Variable>,
): KnownValueEvidence | null {
  const unwrapped = unwrapExpressionParentheses(expression);

  if (unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion") {
    if (broadTypeKind(unwrapped.typeAnnotation) !== null) return null;
    return { type: unwrapped.typeAnnotation };
  }

  if (unwrapped.type === "Literal" || unwrapped.type === "TemplateLiteral") {
    return { type: null };
  }

  if (
    unwrapped.type === "ArrayExpression" ||
    unwrapped.type === "ArrowFunctionExpression" ||
    unwrapped.type === "ClassExpression" ||
    unwrapped.type === "FunctionExpression" ||
    unwrapped.type === "NewExpression" ||
    unwrapped.type === "ObjectExpression"
  ) {
    return { type: null };
  }

  if (unwrapped.type !== "Identifier") return null;
  const variable = resolvedVariableForIdentifier(scopes, unwrapped);
  if (variable === null || visitedVariables.has(variable)) return null;

  const annotatedIdentifier = variable.identifiers.find(
    (identifier) => identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined,
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined && annotatedIdentifier !== undefined) {
    if (functionBoundary(annotatedIdentifier) !== boundary || broadTypeKind(annotation) !== null) {
      return null;
    }
    return { type: annotation };
  }

  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init) ||
    functionBoundary(declarator) !== boundary
  ) {
    return null;
  }

  return knownValueEvidence(
    declarator.init,
    scopes,
    boundary,
    new Set([...visitedVariables, variable]),
  );
}

/**
 * Identifies an immutable local binding with a broad type and known value evidence.
 *
 * @param variable - The variable binding to inspect
 * @param scopes - Scope information used to resolve value evidence
 * @returns Binding metadata when the variable qualifies, or `null` otherwise
 */
function widenedBinding(
  variable: Variable,
  scopes: Parameters<typeof resolvedVariableForIdentifier>[0],
): {
  readonly broadKind: BroadTypeKind;
  readonly evidence: KnownValueEvidence;
  readonly declaredAt: number;
  readonly boundary: ESTree.Node | null;
} | null {
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return null;
  }

  const boundary = functionBoundary(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null ? null : broadTypeKind(initializerAssertion.typeAnnotation);
  const declaredBroadKind = declaredType === undefined ? null : broadTypeKind(declaredType);
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) return null;

  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? assertedExpression(initializerAssertion)
      : declarator.init;
  const evidence = knownValueEvidence(originalExpression, scopes, boundary, new Set([variable]));
  return evidence === null ? null : { broadKind, evidence, declaredAt: declarator.end, boundary };
}

/**
 * Determines whether an asserted type is narrower than the original broad type.
 *
 * @param sourceText - The source text used to compare type syntax.
 * @param broadKind - The broad type category of the original type.
 * @param evidence - Known type information for the value.
 * @param assertedType - The type used in the assertion.
 * @returns `true` if the asserted type is narrower, `false` otherwise.
 */
function assertionIsNarrower(
  sourceText: string,
  broadKind: BroadTypeKind,
  evidence: KnownValueEvidence,
  assertedType: ESTree.TSType,
): boolean {
  if (broadTypeKind(assertedType) !== null) return false;
  if (broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
  if (broadKind === "object") return isDefinitelyObjectType(assertedType);
  return isDefinitelyNarrowerRecordType(assertedType);
}

/** Detect immutable local bindings that erase a known type and are later asserted back to a narrower type. */
export const noWidenThenAssertRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
    },
  },
  createOnce(context) {
    let scopes: Parameters<typeof resolvedVariableForIdentifier>[0] = [];

    const checkAssertion = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      const expression = assertedExpression(node);
      if (expression.type !== "Identifier") return;

      const variable = resolvedVariableForIdentifier(scopes, expression);
      if (variable === null) return;
      const widened = widenedBinding(variable, scopes);
      if (
        widened === null ||
        node.start <= widened.declaredAt ||
        functionBoundary(node) !== widened.boundary ||
        !assertionIsNarrower(
          context.sourceCode.text,
          widened.broadKind,
          widened.evidence,
          node.typeAnnotation,
        )
      ) {
        return;
      }

      context.report({
        node,
        messageId: "widenThenAssert",
        data: { name: expression.name },
      });
    };

    return {
      Program() {
        scopes = context.sourceCode.scopeManager.scopes;
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
