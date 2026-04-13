import { describe, expect, it, vi } from 'vitest';
import { WorkQueue } from '../src/queue.js';

describe('WorkQueue', () => {
  it('runs jobs strictly sequentially in FIFO order', async () => {
    const queue = new WorkQueue();
    const order: number[] = [];
    const slow = (n: number, delay: number) =>
      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(n);
      });

    await Promise.all([slow(1, 30), slow(2, 10), slow(3, 20)]);
    // Despite 2 and 3 being faster individually, FIFO is preserved
    // because the queue never runs two jobs in parallel.
    expect(order).toEqual([1, 2, 3]);
  });

  it('reports depth + busy accurately during execution', async () => {
    const queue = new WorkQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const firstPromise = queue.enqueue(async () => {
      await gate;
    });
    // Second job is waiting while the first is blocked.
    const secondPromise = queue.enqueue(async () => {});

    // Give the queue a tick to start the first job.
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.busy).toBe(true);
    expect(queue.depth).toBe(1);

    release();
    await firstPromise;
    await secondPromise;
    expect(queue.busy).toBe(false);
    expect(queue.depth).toBe(0);
  });

  it('returns each job result on its own promise', async () => {
    const queue = new WorkQueue();
    const [a, b] = await Promise.all([
      queue.enqueue(async () => 'alpha'),
      queue.enqueue(async () => 42),
    ]);
    expect(a).toBe('alpha');
    expect(b).toBe(42);
  });

  it('a job that throws rejects only its own promise without breaking the queue', async () => {
    const queue = new WorkQueue();
    const bad = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const good = queue.enqueue(async () => 'ok');

    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });

  it('handles back-to-back synchronous enqueue bursts without losing jobs', async () => {
    const queue = new WorkQueue();
    const fn = vi.fn(async () => {});
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) promises.push(queue.enqueue(fn));
    await Promise.all(promises);
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('never runs more than one job concurrently under bursty enqueue', async () => {
    const queue = new WorkQueue();
    let inFlight = 0;
    let maxConcurrent = 0;
    const job = async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Yield through the microtask + macrotask queue so a
      // broken parallel implementation would have at least one tick
      // to start a second job before this one finishes.
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
    };
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) promises.push(queue.enqueue(job));
    await Promise.all(promises);
    expect(maxConcurrent).toBe(1);
  });
});
