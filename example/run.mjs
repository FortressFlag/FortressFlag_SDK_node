/**
 * §6's walkthrough vehicle. Run the backend stack locally (`make db-up migrate seed dev`
 * in FortressFlag_Backend), then, with no configuration at all: `node example/run.mjs`.
 *
 * The seed key is committed deliberately and is low-entropy on purpose — it authenticates
 * against a laptop database and nothing else (CLAUDE.md §3's fixture rule).
 */
import { create } from "../dist/index.js";

const SEED_KEY = "ffs_dev_seedseedseedseedseedseedseedseedseedseed000";

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

let client;
try {
  client = create({
    key: env("FF_SERVER_KEY", SEED_KEY),
    baseUrl: env("FF_BASE_URL", "http://localhost:8080"),
    ...(process.env.FF_CACHE_PATH ? { cachePath: process.env.FF_CACHE_PATH } : {}),
  });
} catch (error) {
  console.error(String(error));
  process.exit(1);
}

const outcome = await client.start(AbortSignal.timeout(15_000));
console.log(`start: ${outcome}`);

const contexts = [
  { key: "user-1", tags: { cohort: "beta" } },
  { key: "user-3", tags: { cohort: "beta" } },
];
const flags = ["new-checkout-flow", "dark-mode", "beta-analytics"];

const tick = () => {
  const d = client.diagnostics();
  const at = new Date().toTimeString().slice(0, 8);
  console.log(
    `${at}  fetch=${d.lastFetchStatus} failures=${d.consecutiveFailures} source=${d.snapshotSource || "-"} flags=${d.flagCount}`,
  );
  for (const ctx of contexts) {
    const values = flags.map((f) => `${f}=${client.bool(f, ctx, false)}`).join("  ");
    console.log(`  ${ctx.key}: ${values}`);
  }
};

tick();
const interval = setInterval(tick, 10_000);

process.on("SIGINT", () => {
  clearInterval(interval);
  client.close();
  console.log("diagnostics:", JSON.stringify(client.diagnostics(), null, 2));
  process.exit(0);
});
