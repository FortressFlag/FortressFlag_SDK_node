/**
 * Dotted-numeric version comparison for the semver_* operators — a PORT of the backend's
 * internal/semver, whose package comment is the specification. It is deliberately NOT
 * Semantic Versioning 2.0.0: targeting needs "is this version at least 2.0?", and the
 * semantics are a contract shared with every SDK (contract-v1.md, ADR-0004; pinned by
 * vectors/evaluation.json):
 *
 *   - Split on '.'; compare numeric components left to right.
 *   - A missing component is 0: "2.0" == "2.0.0".
 *   - Components must be non-negative base-10 integers. Anything else — "2.0-beta", "v2",
 *     "" — does not parse. What non-parsing MEANS belongs to the caller: a context value
 *     that does not parse makes the condition not hold (never an error).
 */

/**
 * Bounds one component's length. Ten digits already exceed int32; a longer run of digits
 * is not a version, and refusing it keeps a hostile tag value from turning the comparison
 * into big-number work.
 */
const MAX_VERSION_COMPONENT_DIGITS = 10;

const DIGITS = /^[0-9]+$/;

/**
 * Reports whether s is a dotted non-negative-integer version, parsed as numbers. Returns
 * null rather than throwing: the caller's question is "is this comparable?", and
 * evaluation may never fail over the answer. Components fit in a JS number: ten digits
 * max is under 2^53.
 */
export function parseVersion(s: string): readonly number[] | null {
  if (s === "") {
    return null;
  }
  const parts = s.split(".");
  const version: number[] = [];
  for (const part of parts) {
    if (part === "" || part.length > MAX_VERSION_COMPONENT_DIGITS || !DIGITS.test(part)) {
      return null;
    }
    version.push(Number(part));
  }
  return version;
}

/**
 * Returns -1, 0 or 1 as a is less than, equal to, or greater than b. Missing components
 * read as 0, which is what makes "2.0" equal "2.0.0" — the property the contract documents
 * by example, and the one a naive length comparison would get wrong.
 */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}
