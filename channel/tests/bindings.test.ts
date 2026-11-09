import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BINDING_STALE_MS, BindingOrder, bindingDir, isProcessAlive } from '../src/bindings.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-bindings-'));
  dirs.push(d);
  return d;
}

/**
 * Sessions on one machine sharing a binding dir, with a controllable clock
 * and process table: each gets its own pid, all of them "alive" until killed.
 */
function machine() {
  const dir = tmpDir();
  let clock = 1_000_000;
  const alive = new Set<number>();
  let nextPid = 100;
  const session = () => {
    const pid = nextPid++;
    alive.add(pid);
    return new BindingOrder({ dir, pid, instance: `${pid}-0000000${pid % 10}`, now: () => clock, isAlive: (p) => alive.has(p) });
  };
  return {
    dir,
    session,
    tick: (ms = 1) => { clock += ms; },
    kill: (s: BindingOrder) => { alive.delete(Number(s.instance.split('-')[0])); },
    setMtime: (s: BindingOrder, room: string, ms: number) => {
      const at = new Date(ms);
      fs.utimesSync(path.join(dir, room, `${s.instance}.json`), at, at);
    },
    now: () => clock,
  };
}

describe('BindingOrder', () => {
  it('a single bound session answers its room and nothing else', () => {
    const m = machine();
    const a = m.session();
    expect(a.answers('room-1')).toBe(false);
    a.bind('room-1');
    expect(a.answers('room-1')).toBe(true);
    expect(a.answers('room-2')).toBe(false);
  });

  it('of two sessions bound to a room only the most recently bound one answers', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    expect(b.answers('room-1')).toBe(true);
    expect(a.answers('room-1')).toBe(false);
    expect(a.newerSessions('room-1').map((e) => e.instance)).toEqual([b.instance]);
    expect(b.newerSessions('room-1')).toEqual([]);
  });

  it('binding again makes an older session the most recent one', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    m.tick();
    a.bind('room-1');
    expect(a.answers('room-1')).toBe(true);
    expect(b.answers('room-1')).toBe(false);
  });

  it('binds within the same millisecond keep their order', () => {
    const m = machine();
    const a = m.session();
    a.bind('room-1');
    a.bind('room-2');
    const b = m.session();
    b.bind('room-1');
    // Same clock reading as a's binds: the later bind still wins.
    expect(b.answers('room-1')).toBe(true);
    expect(a.answers('room-1')).toBe(false);
  });

  it('when the most recent session disconnects, the next most recent still-bound one answers', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    const c = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    m.tick();
    c.bind('room-1');
    expect([a, b, c].map((s) => s.answers('room-1'))).toEqual([false, false, true]);

    c.unbind('room-1');
    expect(c.answers('room-1')).toBe(false);
    expect([a, b].map((s) => s.answers('room-1'))).toEqual([false, true]);

    b.clear();
    expect(a.answers('room-1')).toBe(true);
  });

  it('a session that disconnects its last room answers nothing', () => {
    const m = machine();
    const a = m.session();
    a.bind('room-1');
    a.unbind('room-1');
    expect(a.answers('room-1')).toBe(false);
    expect(fs.readdirSync(path.join(m.dir, 'room-1'))).toEqual([]);
  });

  it('a session whose process is gone no longer counts, and its entry is removed', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    m.kill(b);
    expect(a.answers('room-1')).toBe(true);
    expect(fs.readdirSync(path.join(m.dir, 'room-1'))).toEqual([`${a.instance}.json`]);
  });

  it('an entry not refreshed while the live sessions were (a crashed session whose pid came round again) stops counting', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    expect(a.answers('room-1')).toBe(false);
    // b stops refreshing (it crashed, its pid now belongs to something else); a keeps refreshing.
    m.setMtime(b, 'room-1', m.now());
    m.tick(BINDING_STALE_MS + 1);
    a.refresh();
    expect(a.answers('room-1')).toBe(true);
    // Within the window it still counts (a second of margin for the file system's time resolution).
    m.setMtime(b, 'room-1', m.now() - BINDING_STALE_MS + 1000);
    expect(a.answers('room-1')).toBe(false);
  });

  it('after a sleep, when nobody has refreshed yet, the order holds', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    m.setMtime(a, 'room-1', m.now());
    m.setMtime(b, 'room-1', m.now());
    m.tick(10 * BINDING_STALE_MS);
    expect(a.answers('room-1')).toBe(false);
    expect(b.answers('room-1')).toBe(true);
  });

  it('an entry under its own pid but another instance is a dead predecessor', () => {
    const m = machine();
    const a = m.session();
    a.bind('room-1');
    const pid = Number(a.instance.split('-')[0]);
    const ghost = new BindingOrder({ dir: m.dir, pid, instance: `${pid}-deadbeef`, now: () => m.now() + 5, isAlive: () => true });
    ghost.bind('room-1');
    expect(a.answers('room-1')).toBe(true);
    expect(fs.existsSync(path.join(m.dir, 'room-1', `${pid}-deadbeef.json`))).toBe(false);
  });

  it('refresh writes a removed entry again with its original bind time', () => {
    const m = machine();
    const a = m.session();
    const b = m.session();
    a.bind('room-1');
    m.tick();
    b.bind('room-1');
    fs.rmSync(path.join(m.dir, 'room-1', `${b.instance}.json`));
    expect(a.answers('room-1')).toBe(true);
    m.tick(1000);
    b.refresh();
    expect(a.answers('room-1')).toBe(false);
    expect(b.answers('room-1')).toBe(true);
    // The rewritten entry carries b's first bind time, so a later bind of a still wins.
    m.tick();
    a.bind('room-1');
    expect(a.answers('room-1')).toBe(true);
  });

  it('ignores junk in the room directory and never turns a room id into a path outside it', () => {
    const m = machine();
    const a = m.session();
    a.bind('room-1');
    fs.writeFileSync(path.join(m.dir, 'room-1', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(m.dir, 'room-1', '999-00000000.json'), '{half');
    fs.writeFileSync(path.join(m.dir, 'room-1', '998-00000000.json'), JSON.stringify({ instance: 'x', pid: 'nope', boundAt: 9e15 }));
    expect(a.answers('room-1')).toBe(true);

    a.bind('../escape');
    expect(a.answers('../escape')).toBe(true);
    expect(fs.existsSync(path.join(m.dir, '..', 'escape'))).toBe(false);
    a.unbind('../escape');
    expect(a.answers('../escape')).toBe(false);
  });

  it('writes its entries for the owner only and records the session id', () => {
    const m = machine();
    const a = m.session();
    a.setSessionId('sess-a');
    a.bind('room-1');
    const file = path.join(m.dir, 'room-1', `${a.instance}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ instance: a.instance, sessionId: 'sess-a' });
    expect(fs.readdirSync(path.join(m.dir, 'room-1'))).toEqual([`${a.instance}.json`]);
  });

  it('keeps going (and says so) when the entry cannot be written', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'room-1'), 'a file where the room directory should be');
    const warnings: string[] = [];
    const a = new BindingOrder({ dir, log: (_level, message) => warnings.push(message) });
    a.bind('room-1');
    expect(a.answers('room-1')).toBe(true);
    expect(warnings[0]).toMatch(/could not record the binding of room room-1/);
  });

  it('keys the order by agent: a hash of the token, never the token itself', () => {
    const a = bindingDir('/state', 'byoa_secret_one');
    expect(a).toMatch(/^\/state\/bindings\/[0-9a-f]{16}$/);
    expect(a).not.toContain('byoa_secret_one');
    expect(bindingDir('/state', 'byoa_secret_two')).not.toBe(a);
  });

  it('isProcessAlive sees this process and not a pid that does not exist', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});
