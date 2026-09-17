# FortressFlag Node SDK

> **ADR-nnnn** refers to FortressFlag's internal architecture decision records. The public
> contract every SDK implements is `FortressFlag_Standards`; decision records are not published.

FortressFlag's **Node server SDK** (backend ADR-0020): zero-dependency TypeScript, ESM-only.
Polls the server data plane's ruleset export with an `ffs_` server key and evaluates flags
**locally, in-process** — no network hop per flag check.

```ts
import { create } from "@fortressflag/sdk-node";

const client = create({ key: process.env.FF_SERVER_KEY }); // the one place the SDK throws
await client.start(); // resolves at the first ruleset (or the deadline); never fatal
const enabled = client.bool("dark-mode", { key: "user-42", tags: { cohort: "beta" } }, false);
client.close();
```

It implements
[`FortressFlag_Standards/contracts/server-contract-v1.md`](https://github.com/FortressFlag/FortressFlag_Standards/blob/development/contracts/server-contract-v1.md)
— owned by `FortressFlag_Backend`, changed only via ADRs there. Zero runtime dependencies;
evaluation never throws and no promise from the API rejects. See `CLAUDE.md` for the rules
this repo holds itself to.

Every ruleset carries an Ed25519 signature that the SDK verifies against FortressFlag's
production key before a single flag is served (backend ADR-0025); `signatureDisabled` is the
explicit opt-out for a local backend without a signing key.

**The `ffs_` server key is a genuine secret** — treat it like a database password. Store it
in an environment variable or a secret manager, never in client code or logs.
