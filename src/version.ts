/**
 * The running build's version, read once at startup from the repository's
 * root package.json and reported by GET /health so a rebuilt deployment can
 * be identified from outside.
 *
 * The default path is resolved relative to this module, so it finds the root
 * package.json both under `tsx src/index.ts` (src/version.ts -> ../package.json)
 * and from the compiled image (dist/version.js -> /app/package.json, which the
 * Dockerfile copies into the runtime stage).
 *
 * A read failure must never take the server down: any error (missing file,
 * unreadable file, malformed JSON) and any non-string or empty `version`
 * value fall back to "unknown" with a single console.warn per read. The
 * caller evaluates readVersion() once at module scope, so a broken package.json
 * costs exactly one warning at startup and "unknown" in every /health reply.
 */
import { readFileSync } from 'node:fs';

export const UNKNOWN_VERSION = 'unknown';

export function readVersion(rootPackageJson: URL | string = new URL('../package.json', import.meta.url)): string {
  try {
    const parsed = JSON.parse(readFileSync(rootPackageJson, 'utf8'));
    const version = parsed?.version;
    if (typeof version !== 'string' || version === '') {
      console.warn(`[version] package.json has no non-empty string "version"; reporting "${UNKNOWN_VERSION}"`);
      return UNKNOWN_VERSION;
    }
    return version;
  } catch (err: any) {
    console.warn(`[version] cannot read package.json (${err?.code ?? err?.message}); reporting "${UNKNOWN_VERSION}"`);
    return UNKNOWN_VERSION;
  }
}

export const APP_VERSION = readVersion();
