/**
 * Serial work queue. One job at a time, FIFO, no parallelism.
 *
 * Rationale: the bridge drives a headless Claude process per job.
 * Running them in parallel for a single agent makes no sense — the
 * agent has one voice, and overlapping runs would produce
 * conflicting replies in the same room. The queue enforces sequential
 * execution and gives us a clean place to back-pressure if Claude is
 * slow or stuck.
 *
 * Jobs that throw are logged and discarded — the queue never
 * breaks on a single bad job. Callers are expected to do their own
 * error surfacing (e.g. post an error message back to the room).
 */

export type Job<T = unknown> = () => Promise<T>;

export class WorkQueue {
  private readonly pending: Array<{
    job: Job;
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
  }> = [];
  private running = false;

  /** Current queue depth (jobs waiting, excluding any currently running). */
  get depth(): number {
    return this.pending.length;
  }

  /** Whether a job is currently executing. */
  get busy(): boolean {
    return this.running;
  }

  /**
   * Enqueue a job. Returns a promise that resolves (or rejects) with
   * the job's outcome once it has actually run. Enqueue order is
   * strictly FIFO.
   */
  enqueue<T>(job: Job<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        job: job as Job,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        try {
          const result = await next.job();
          next.resolve(result);
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
