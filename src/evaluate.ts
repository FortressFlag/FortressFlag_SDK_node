/**
 * Local evaluation — the reason this SDK exists (Founding §3: evaluation happens as close
 * to the customer as possible), and a byte-for-byte behavioural PORT of the backend's
 * clientapi evaluateValue walk via the Go SDK. The implementations are pinned to each
 * other by vectors/evaluation.json; a semantic difference here is a wire-contract bug,
 * never a local judgement call. No I/O, no logging, no allocation beyond the walk — this
 * sits on the customer's hot path.
 */
import { bucket } from "./bucket.js";
import { decodeValue, type DecodedValue, type FlagConfig, type FlagRule } from "./ruleset.js";
import { compareVersions, parseVersion } from "./semver.js";

/**
 * Walks the rules in order and returns the first match's serve value, or the default when
 * nothing matches, and whether the flag has a value at all — a multivariate flag with no
 * default variant and no matching rule answers { ok: false }: the caller's fallback
 * serves. The per-rule semantics, exactly as the contract states them:
 *
 *   - A rule matches when EVERY condition holds — AND within a rule, first-match-wins
 *     across rules. An EMPTY condition list holds vacuously (the terminal "everyone else"
 *     rule).
 *   - A condition whose tag key is absent from the context's tags does not hold; never an
 *     error. eq/neq are exact string comparison, case-sensitive, no trimming. The semver
 *     operators compare via parseVersion; an unparseable value on EITHER side makes the
 *     condition not hold. An operator this build does not recognise does not hold — fail
 *     closed into the default (Founding §8.3).
 *   - The rollout gate: conditions held, now the percentage decides. The bucket is
 *     computed at most once per flag, only when a matching rule actually carries a gate,
 *     and a gated-out context falls THROUGH to later rules and the default — which is what
 *     makes "50% rule, then everyone-else rule" compose under first-match-wins. A gate of
 *     0 is a real gate that matches nobody: presence is `!== undefined && !== null`,
 *     never truthiness.
 *   - A rule whose serve value does not follow the flag's kind cannot be written through
 *     the management API; if one ever appears, fail closed past it rather than serve a
 *     guess.
 */
export function evaluateFlag(
  config: FlagConfig,
  tags: Readonly<Record<string, string>>,
  contextKey: string,
  flagKey: string,
): DecodedValue {
  let contextBucket = -1;
  for (const rule of config.rules) {
    if (!ruleMatches(rule, tags)) {
      continue;
    }
    if (rule.rolloutPercentage !== undefined && rule.rolloutPercentage !== null) {
      if (contextBucket < 0) {
        contextBucket = bucket(contextKey, flagKey);
      }
      if (contextBucket >= rule.rolloutPercentage) {
        continue;
      }
    }
    const served = decodeValue(rule.serve, config.kind);
    if (served.ok) {
      return served;
    }
  }
  return decodeValue(config.default, config.kind);
}

/**
 * ANDs the rule's conditions: every one must hold. Iterating an empty array runs zero
 * times, which is exactly the vacuous truth the contract specifies.
 */
function ruleMatches(rule: FlagRule, tags: Readonly<Record<string, string>>): boolean {
  for (const condition of rule.conditions) {
    const tagValue = tags[condition.tagKey];
    if (tagValue === undefined) {
      return false;
    }
    if (!conditionHolds(condition.operator, condition.value, tagValue)) {
      return false;
    }
  }
  return true;
}

function conditionHolds(operator: string, ruleValue: string, tagValue: string): boolean {
  switch (operator) {
    case "eq":
      return tagValue === ruleValue;
    case "neq":
      return tagValue !== ruleValue;
    case "semver_eq":
    case "semver_gt":
    case "semver_gte":
    case "semver_lt":
    case "semver_lte": {
      const context = parseVersion(tagValue);
      if (context === null) {
        return false;
      }
      const target = parseVersion(ruleValue);
      if (target === null) {
        return false;
      }
      const cmp = compareVersions(context, target);
      switch (operator) {
        case "semver_eq":
          return cmp === 0;
        case "semver_gt":
          return cmp > 0;
        case "semver_gte":
          return cmp >= 0;
        case "semver_lt":
          return cmp < 0;
        default: // semver_lte
          return cmp <= 0;
      }
    }
    default:
      return false;
  }
}
