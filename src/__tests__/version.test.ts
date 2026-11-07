/**
 * readVersion() in src/version.ts: the /health version read. Precedence is
 * file value, else "unknown" with exactly one console.warn per failed read;
 * a failure must return, never throw (it runs at module scope during import,
 * so throwing would stop the server from booting).
 *
 * Cases (each input alone):
 *   - valid string "version" in the file  -> the file value wins, no warning
 *   - unreadable file (missing path)      -> "unknown" + one warning
 *   - unreadable path (a directory)       -> "unknown" + one warning
 *   - malformed JSON                      -> "unknown" + one warning
 *   - non-string "version" (number)       -> "unknown" + one warning
 *   - "version" key absent                -> "unknown" + one warning
 *   - "version" present but empty string  -> "unknown" + one warning
 *   - module-scope APP_VERSION            -> equals the root package.json version
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION, UNKNOWN_VERSION, readVersion } from '../version.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('readVersion', () => {
  it('returns the version string from the file (the file value wins) and logs nothing', () => {
    expect(readVersion(path.join(FIXTURES, 'version-present.json'))).toBe('9.9.9-test');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns "unknown" for a missing file, with exactly one warning and no throw', () => {
    expect(readVersion(path.join(FIXTURES, 'version-does-not-exist.json'))).toBe(UNKNOWN_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns "unknown" for an unreadable path (a directory), with exactly one warning', () => {
    expect(readVersion(FIXTURES)).toBe(UNKNOWN_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns "unknown" for malformed JSON, with exactly one warning and no throw', () => {
    expect(readVersion(path.join(FIXTURES, 'version-badjson.json'))).toBe(UNKNOWN_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns "unknown" for a non-string version (number), with exactly one warning', () => {
    expect(readVersion(path.join(FIXTURES, 'version-nonstring.json'))).toBe(UNKNOWN_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns "unknown" when the version key is absent, with exactly one warning', () => {
    expect(readVersion(path.join(FIXTURES, 'version-absent.json'))).toBe(UNKNOWN_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns "unknown" for an empty-string version, with exactly one warning', () => {
    expect(readVersion(path.join(FIXTURES, 'version-empty.json'))).toBe(UNKNOWN_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('APP_VERSION (read once at module scope with the default path)', () => {
  it('equals the repository root package.json version', () => {
    expect(APP_VERSION).toBe(ROOT_VERSION);
  });
});
