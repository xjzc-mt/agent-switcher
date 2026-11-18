/* Bounded parallel queries; foreground requests can overtake pending background work. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccountRefreshQueue = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  return class AccountRefreshQueue {
    constructor({ run, onChange = () => {}, canAutoRefresh = () => true, concurrency = 3 }) {
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
      this.run = run;
      this.onChange = onChange;
      this.canAutoRefresh = canAutoRefresh;
      this.concurrency = concurrency;
      this.jobs = new Map();
      this.running = 0;
    }
    get(key) { return this.jobs.get(key); }
    request(key, payload, { force = false, priority = 0 } = {}) {
      let job = this.jobs.get(key);
      if (job) {
        job.force ||= force;
        job.priority = Math.max(job.priority, priority);
        this.onChange();
        return job.promise;
      }
      job = { key, payload, force, priority, state: 'queued' };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      this.jobs.set(key, job);
      this.onChange();
      queueMicrotask(() => this.drain());
      return job.promise;
    }
    drain() {
      while (this.running < this.concurrency) {
        const job = [...this.jobs.values()].filter(job => job.state === 'queued').sort((a, b) => b.priority - a.priority)[0];
        if (!job) return;
        job.state = 'running';
        this.running++;
        this.execute(job);
      }
    }
    async execute(job) {
      let result, error;
      try {
        if (!job.force && !this.canAutoRefresh()) result = { skipped: true };
        else {
          this.onChange();
          result = await this.run(job.payload, job.force);
        }
      } catch (caught) { error = caught; }
      this.jobs.delete(job.key);
      this.running--;
      this.onChange();
      if (error) job.reject(error); else job.resolve(result);
      queueMicrotask(() => this.drain());
    }
  };
});
