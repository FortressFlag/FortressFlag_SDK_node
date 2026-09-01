// Flat config. The rules pinned to "error" below are the lint half of the crash-primitives
// gate — CI's separate grep job is the other half, kept apart deliberately because a lint
// config is one pull request away from being relaxed (the web SDK's arrangement, ported).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "example/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `any` silences the compiler exactly where this SDK needs it most — at the boundary
      // with a server we treat as hostile.
      "@typescript-eslint/no-explicit-any": "error",
      // A non-null assertion is TypeScript's `try!`. The SDK must never throw inside a
      // customer's process (Founding §8.1).
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true },
      ],
    },
  },
);
