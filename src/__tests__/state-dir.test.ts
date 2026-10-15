/**
 * Tests for src/state-dir.ts - where the read tracker, metrics log and JWT
 * cache live. STATE_DIR relocates them (the Docker image points it at a
 * directory the unprivileged `app` user owns); unset or blank keeps the
 * project root, next to dist/.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveStateDir, stateFile } from '../state-dir.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const original = process.env.STATE_DIR;

afterEach(() => {
  if (original === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = original;
});

describe('state-dir', () => {
  it('defaults to the project root when STATE_DIR is unset', () => {
    delete process.env.STATE_DIR;
    expect(resolveStateDir()).toBe(projectRoot);
    expect(stateFile('metrics.jsonl')).toBe(path.join(projectRoot, 'metrics.jsonl'));
  });

  it('treats a blank STATE_DIR like unset', () => {
    process.env.STATE_DIR = '   ';
    expect(resolveStateDir()).toBe(projectRoot);
  });

  it('puts all three state files under STATE_DIR when set', () => {
    process.env.STATE_DIR = '/var/lib/gateway-state';
    expect(stateFile('.read-tracker.json')).toBe('/var/lib/gateway-state/.read-tracker.json');
    expect(stateFile('metrics.jsonl')).toBe('/var/lib/gateway-state/metrics.jsonl');
    expect(stateFile('.jwt-cache-gateway.json')).toBe('/var/lib/gateway-state/.jwt-cache-gateway.json');
  });
});
