import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const AGENTS_FILE = "AGENTS.md";

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

/**
 * Resolves the canonical paths for root and target, verifying the target is contained within root.
 *
 * @param root - The root directory path
 * @param inputPath - The target file path (absolute or relative to root)
 * @returns An object with canonical root and target paths if the target is contained in root, otherwise `undefined`
 */
export async function resolveContainedTarget(
  root: string,
  inputPath: string,
): Promise<{ root: string; target: string } | undefined> {
  try {
    const canonicalRoot = await realpath(root);
    const requested = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
    const canonicalTarget = await realpath(requested);
    if (!isContained(canonicalRoot, canonicalTarget)) return undefined;
    return { root: canonicalRoot, target: canonicalTarget };
  } catch {
    return undefined;
  }
}

/** Find nested AGENTS.md files from the project root toward the target. */
export async function findNestedAgentsFiles(root: string, inputPath: string): Promise<string[]> {
  const contained = await resolveContainedTarget(root, inputPath);
  if (!contained) return [];

  const found: string[] = [];
  let directory = dirname(contained.target);
  while (directory !== contained.root) {
    const candidate = join(directory, AGENTS_FILE);
    try {
      const canonicalCandidate = await realpath(candidate);
      if (
        canonicalCandidate !== contained.target &&
        isContained(contained.root, canonicalCandidate)
      ) {
        found.push(canonicalCandidate);
      }
    } catch {
      // The directory has no readable AGENTS.md.
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found.reverse();
}
