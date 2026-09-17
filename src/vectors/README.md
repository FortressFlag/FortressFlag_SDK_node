# Vendored test vectors

These files are **verbatim copies**; the canonical home is
`FortressFlag_Standards/vectors/` (the device-ids.json vendoring precedent from the web
SDK). A vector change is a wire-contract change arriving via a backend ADR — update the
canonical file first, then re-vendor here; never edit only this copy, and **never treat a
failing vector as a test to fix**.

`signing.json` (backend ADR-0025) carries whole envelopes as bytes: feed each `envelope` to
`verifyEnvelope` unchanged — never re-serialise — under a policy that trusts the file's
`publicKey` as `keyId`.

`buckets.json`'s input field is named `deviceID` because the backend hashes device IDs;
this SDK feeds its caller's context key through the same algorithm — identical bytes in,
identical bucket out is the whole contract.
