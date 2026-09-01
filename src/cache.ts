/**
 * The opt-in durable cache (ADR-0016): the file named by cachePath holds the last VERIFIED
 * envelope's raw bytes — verbatim, never a re-serialisation (re-serialising would strip
 * future fields and break the signature on reload), never parsed values, never the key,
 * never any evaluation context. The caller re-verifies on load (expiry unenforced — the
 * asymmetry), so poisoning the cache requires forging whatever the transport requires, and
 * the cache inherits every transport guarantee for free.
 *
 * Every failure here degrades to in-memory operation with a note on diagnostics() — a
 * cache problem is never the customer's problem.
 */
import { randomBytes } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_RESPONSE_BYTES } from "./transport.js";

export interface FileCache {
  load(): Promise<Uint8Array | null>;
  store(raw: Uint8Array): Promise<boolean>;
}

export function newFileCache(path: string): FileCache {
  return {
    /**
     * Returns the cached envelope bytes, or null when there is nothing usable. A file
     * larger than the transport's own response cap was not written by us; it is ignored
     * rather than read (a hostile or broken writer must not balloon this process's
     * memory) — the size is checked on the open handle before reading.
     */
    async load(): Promise<Uint8Array | null> {
      let handle;
      try {
        handle = await open(path, "r");
      } catch {
        return null;
      }
      try {
        const { size } = await handle.stat();
        if (size === 0 || size > MAX_RESPONSE_BYTES) {
          return null;
        }
        return await handle.readFile();
      } catch {
        return null;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    /**
     * Atomically replaces the cache file with raw. Temp-file-in-the-SAME-directory +
     * rename, deliberately: a temp file in the system temp directory makes the rename a
     * cross-filesystem move, which fails (EXDEV) — the "cache that never persists and
     * nothing notices" bug class (on Android the equivalent failed silently under SELinux
     * and every write was lost). The rename is what makes a crash mid-write leave the last
     * good envelope in place rather than a truncated one. Mode 0600 is EXPLICIT: Node's
     * default is 0666 minus umask, and Go's CreateTemp 0600 does not port itself.
     */
    async store(raw: Uint8Array): Promise<boolean> {
      if (raw.byteLength === 0 || raw.byteLength > MAX_RESPONSE_BYTES) {
        return false;
      }
      const tempPath = join(dirname(path), `.fortressflag-cache-${randomBytes(8).toString("hex")}`);
      try {
        await writeFile(tempPath, raw, { mode: 0o600, flag: "wx" });
        await rename(tempPath, path);
        return true;
      } catch {
        await rm(tempPath, { force: true }).catch(() => undefined);
        return false;
      }
    },
  };
}
