import path from 'path';
import { fileURLToPath } from 'node:url';

// __dirname has no ESM equivalent global (root package.json is
// "type": "module"); derive it from import.meta.url.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Directory for the gateway's own state files (read tracker, metrics log,
 * JWT cache). Set `STATE_DIR` to put them somewhere writable, for example a
 * mounted volume; unset or blank keeps the original location, the directory
 * above this module (the project root, next to `dist/`). The directory must
 * already exist and be writable by the gateway process.
 */
export function resolveStateDir(): string {
  const configured = process.env.STATE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(moduleDir, '..');
}

/** Absolute path of a state file inside the state directory. */
export function stateFile(name: string): string {
  return path.join(resolveStateDir(), name);
}
