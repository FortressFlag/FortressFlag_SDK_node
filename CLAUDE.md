# FortressFlag_SDK_node — Agent & Contributor Guide

> **This repo inherits the FortressFlag founding principles.** The canonical document lives in
> the backend repo (`FortressFlag_Backend/CLAUDE.md`, the founding document) — read it before
> design decisions.
>
> ADR-nnnn refers to FortressFlag's internal architecture decision records. The public contract
> every SDK implements is `FortressFlag_Standards`; decision records are not published.
>
> Priority order when in doubt: **Security → Compliance → Efficiency → Cost.**

---

## 1. This Repo

The **Node server SDK** (backend ADR-0020, inheriting ADR-0016's decisions): zero-dependency
TypeScript, ESM-only. It embeds in a customer's backend, downloads the full evaluable ruleset
for one project + environment via an `ffs_` server key (`GET /v1/server/ruleset`), and
evaluates flags **locally, in-process**. It implements
`FortressFlag_Standards/contracts/server-contract-v1.md` and ports
`vectors/evaluation.json` + `vectors/buckets.json` as unit tests. The contract is owned by
`FortressFlag_Backend`; changes arrive only via ADRs there.

## 2. Fail-safe evaluation (Founding §8.1, §8.4)

- **The SDK never throws from evaluation, never rejects a public promise, never exits the
  process.** The host is the customer's PROCESS. CI greps library sources for
  `process.exit(` and `process.abort(`.
- `create()` is the ONE place the SDK may throw (`MalformedKeyError`, before anything
  serves). Getters always answer; every failure resolves to the caller's fallback with the
  reason on `diagnostics()`. There is no compiled-in `false` tier — the caller states a
  fallback at every call site (ADR-0016).
- The last verified ruleset serves through any outage indefinitely. **Expiry governs
  freshness, never validity**: a live response past `expiresAt` is refused; a cache-file
  load never is.
- **The poller must never keep the customer's process alive**: the poll timer is unref'd
  (ADR-0020). Removing the `.unref()` turns "embed FortressFlag" into "your CLI never
  exits" — it is load-bearing, not tidiness.

## 3. The server key IS a secret (server-contract-v1, ADR-0015)

The explicit inversion of the client SDKs' "the SDK key is not a secret":

- The raw `ffs_` key lives in memory and goes out on the `Authorization` header — nowhere
  else, ever. Never a log line, an error message, a cache file, or a thrown Error's text.
- The only loggable form is the prefix: `ffs_<env>_` plus six characters.
- Test fixtures use short, low-entropy keys (`ffs_dev_k`). A realistic-looking `ffs_` value
  in this repo SHOULD page a secret scanner — never commit one, never allowlist a finding;
  shorten the fixture.

## 4. Context keys and tags are the customer's data (Founding §7.3)

Never logged, never persisted (the opt-in cache holds the RULESET envelope, never contexts),
never transmitted. The context key is an **opaque string** — never validated against the
client SDKs' `dev_`/`sim_` shape, never trimmed or normalised: the bucket hashes exactly the
bytes given, or cohorts flip between components.

## 5. Zero runtime dependencies (ADR-0020)

`package.json` has **no `dependencies` block, and that absence is the gate** — CI asserts
it. Everything the SDK needs is the platform: global `fetch`, `node:crypto`,
`node:fs/promises`. devDependencies are tooling and never ship. A runtime dependency is a
supply-chain decision the maintainer owns: **ask, don't add.**

## 6. Network surface

`GET /v1/server/ruleset?sv=1` with `Authorization`, `Accept`, and `If-None-Match` — nothing
else, ever. No SDK-version header, no telemetry: an undocumented header is an additive
contract change that goes through a backend ADR. Poll 60 s default, floored at the
contract's 30; backoff cap 1800 s with ±20% jitter ON THE SUCCESS PATH TOO; redirects
refused (`redirect: "manual"` — a followed redirect could replay the Authorization header);
bodies capped at 1 MiB.

## 7. Workflow

- Default branch `development`; all changes via PR; squash merge, linear history, `(#N)` on
  every development commit. CI is the merge gate — we cannot recall a shipped SDK.
- Commits and PRs carry FortressFlag authorship, never a personal identity: local commits
  as `FortressFlag <noreply@fortressflag.com>`; PRs opened and merged via the
  `fortressflag` GitHub App.
- **The public API (`src/index.ts`) and the consumed contract are backward-compatibility
  sacred** (Founding §5, §8.3).
- Local gate, identical to CI: `pnpm build && pnpm lint && pnpm test`.
- `src/vectors/*.json` are verbatim vendored copies; the canonical home is
  `FortressFlag_Standards/vectors/`. A vector change is a wire-contract change arriving via
  a backend ADR — never a test fix, and never edited only here.
