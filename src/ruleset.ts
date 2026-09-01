/**
 * The ruleset payload types, in the server export's wire shape (server-contract-v1.md).
 *
 * These are this package's own types, decoded from the wire — a PORT of the backend's
 * clientapi rule types, never a share (the port-don't-share doctrine: the two components
 * must be free to diverge, and nothing management-side can silently ride into this
 * decoder). Module-internal: the wire shape is not public API; the public surface is
 * index.ts.
 *
 * JSON.parse hands back `undefined` for an absent key and `null` for an explicit null —
 * and ABSENT and `false` must not be confused (a boolean flag's `false` default is a value;
 * a multivariate flag with no default variant has the field omitted). decodeValue treats
 * absent and null identically as no-value and never collapses either into `false`.
 */

/** One ANDed test inside a rule. Position is implicit in array order. */
export interface FlagCondition {
  readonly tagKey: string;
  readonly operator: string;
  readonly value: string;
}

/**
 * One targeting rule: the ordered ANDed conditions, the value a match serves, and the
 * optional rollout gate. `serve` stays unknown until evaluation decodes it by the flag's
 * kind. `rolloutPercentage: 0` is a real gate that matches nobody — falsy checks are the
 * recorded trap; test presence with `!== undefined && !== null`, never truthiness.
 */
export interface FlagRule {
  readonly conditions: readonly FlagCondition[];
  readonly serve: unknown;
  readonly rolloutPercentage?: number | null;
}

/** Everything the export says about one flag. `default` may be absent (multivariate). */
export interface FlagConfig {
  readonly kind: string;
  readonly default?: unknown;
  readonly rules: readonly FlagRule[];
}

/** A decoded value with its presence bit — the (any, bool) pair, in TypeScript. */
export type DecodedValue = { readonly value: unknown; readonly ok: boolean };

const NO_VALUE: DecodedValue = { value: undefined, ok: false };

/**
 * Decodes a raw wire value by the flag's kind, reporting whether a usable value was
 * present. Absent (`undefined`) and an explicit `null` are treated identically as
 * no-value: the contract omits the field for a multivariate flag with no default variant,
 * and a decoder that threw on a null would violate fail-safe. A value that does not follow
 * the kind, or a kind this build does not know, is no-value too: fail closed into the
 * caller's fallback rather than serve a guess (Founding §8.3). Numbers must be finite —
 * JSON cannot express NaN/Infinity, so a non-finite number here is a hostile decode.
 */
export function decodeValue(raw: unknown, kind: string): DecodedValue {
  if (raw === undefined || raw === null) {
    return NO_VALUE;
  }
  switch (kind) {
    case "boolean":
      return typeof raw === "boolean" ? { value: raw, ok: true } : NO_VALUE;
    case "string":
      return typeof raw === "string" ? { value: raw, ok: true } : NO_VALUE;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? { value: raw, ok: true } : NO_VALUE;
    default:
      return NO_VALUE;
  }
}
