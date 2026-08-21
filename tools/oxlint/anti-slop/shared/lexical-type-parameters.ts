import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

/**
 * Determines whether a value is an ESTree node.
 *
 * @param value - The value to inspect
 * @returns `true` if the value is a non-null object with a string `type` property, `false` otherwise.
 */
function isNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/**
 * Collects names declared by `TSInferType` descendants into a set.
 *
 * @param node - The AST node whose descendants are traversed
 * @param visitorKeys - Mapping of node types to their child properties
 * @param names - Set to which inferred type parameter names are added
 */
function collectInferTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	names: Set<string>,
): void {
	if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const value = record[key];
		if (isNode(value)) {
			collectInferTypeParameterNames(value, visitorKeys, names);
			continue;
		}
		if (!Array.isArray(value)) continue;
		for (const child of value) {
			if (isNode(child)) collectInferTypeParameterNames(child, visitorKeys, names);
		}
	}
}

/**
 * Determines the type-parameter names in scope at an AST node.
 *
 * @param node - The AST node whose lexical scope is examined
 * @param visitorKeys - AST child-property mappings used to traverse descendant nodes
 * @returns The type-parameter names in scope at `node`
 */
export function lexicalTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
): ReadonlySet<string> {
	const names = new Set<string>();
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
			for (const parameter of current.typeParameters?.params ?? []) {
				names.add(parameter.name.name);
			}
		}
		if (
			current.type === "TSMappedType" &&
			(descendant === current.nameType || descendant === current.typeAnnotation)
		) {
			names.add(current.key.name);
		}
		if (current.type === "TSConditionalType" && descendant === current.trueType) {
			collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
		}
		descendant = current;
		current = current.parent;
	}
	return names;
}
