/** Accepts arrays containing only strings, including empty arrays. */
export function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;

  for (const item of value) {
    if (typeof item !== "string") return false;
  }

  return true;
}
