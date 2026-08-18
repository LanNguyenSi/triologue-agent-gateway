/**
 * Smoke test for the compiled dist/ entrypoint - the exact thing the
 * Dockerfile's `CMD ["node", "dist/index.js"]` runs, not `tsx src/index.ts`
 * (the systemd/prod path, which resolves TS + extensionless imports itself
 * and is unaffected by tsc's module settings).
 *
 * Regression this guards: root package.json previously had no
 * "type": "module" while tsconfig emitted ESM `import` syntax with
 * extensionless relative specifiers (`from './auth'`); Node reparsed the
 * output as ESM and then failed strict ESM resolution with
 * ERR_MODULE_NOT_FOUND before main() ever ran. It also guards the
 * `npm run build` output actually shipped in the Docker image: no compiled
 * test files should land in dist/.
 *
 * beforeAll always runs a fresh build (rather than trusting a stale dist/
 * from a previous run) so this test fails whenever the current source no
 * longer produces a bootable entrypoint. Measured failure mechanism of the
 * mutation probe: temporarily removing "type": "module" fails the BUILD
 * (5x TS1470, import.meta not allowed in CommonJS output) inside beforeAll
 * - node is never spawned. A reverted extensionless import is likewise
 * caught by tsc (TS2835) under NodeNext. The ERR_MODULE_NOT_FOUND
 * assertion below is belt-and-braces for mechanisms tsc cannot see, not
 * the primary guard.
 *
 * The build goes to a temp outDir so this test never touches the repo's
 * dist/ (a dev following CONTRIBUTING's build-then-test flow keeps their
 * fresh dist/, and no parallel test shares mutable state).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST_DIR = path.join(ROOT, '.dist-boot-test');
const DIST_INDEX = path.join(DIST_DIR, 'index.js');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runNode(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('dist/ entrypoint (matches Dockerfile CMD ["node", "dist/index.js"])', () => {
  beforeAll(() => {
    rmSync(DIST_DIR, { recursive: true, force: true });
    execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', DIST_DIR], {
      cwd: ROOT,
      stdio: 'pipe',
    });
  }, 60_000);

  afterAll(() => {
    rmSync(DIST_DIR, { recursive: true, force: true });
  });

  it('produced dist/index.js', () => {
    expect(existsSync(DIST_INDEX)).toBe(true);
  });

  it('does not contain compiled test files (dist ships in the Docker image as-is)', () => {
    expect(existsSync(path.join(DIST_DIR, '__tests__'))).toBe(false);
    for (const entry of readdirSync(DIST_DIR)) {
      expect(entry).not.toMatch(/\.test\.js$/);
    }
  });

  it('node dist/index.js reaches main() and exits 1 with a clear error when GATEWAY_TOKEN is missing', async () => {
    const { stderr, code } = await runNode([DIST_INDEX], { GATEWAY_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('GATEWAY_TOKEN required');
    // The pre-fix failure mode: ESM resolution died on the first relative
    // import before main() ever ran. Reaching the GATEWAY_TOKEN check above
    // already proves that didn't happen, but assert it explicitly too.
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  }, 15_000);

  it('tsx src/index.ts (the actual systemd/prod path) reaches main() and exits 1 without GATEWAY_TOKEN', async () => {
    // Guards prod against a future CJS-ism (e.g. a reintroduced __dirname)
    // regressing under type:module - the highest-risk surface of the ESM
    // switch, and the path dist-boot alone does not cover.
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, GATEWAY_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise<RunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ stdout, stderr, code }));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('GATEWAY_TOKEN required');
  }, 30_000);
});
