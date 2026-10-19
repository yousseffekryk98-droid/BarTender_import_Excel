'use strict';
// Persistent automation job queue with retries, scheduling (runAt) and approval gating.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('../store.cjs');

const FINAL = new Set(['done', 'failed', 'cancelled', 'rejected']);

class JobQueue {
  /**
   * deps: { dir, execute(job) → Promise<result>, log(entry), now(), onChange(job) }
   */
  constructor(deps) {
    this.deps = deps;
    this.file = path.join(deps.dir, 'queue.json');
    this.jobs = [];
    this.timer = null;
    this.running = false;
    this.stopped = true;
  }

  now() { return this.deps.now ? this.deps.now() : Date.now(); }

  async load() {
    await fs.mkdir(this.deps.dir, { recursive: true });
    try { this.jobs = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { this.jobs = []; }
    if (!Array.isArray(this.jobs)) this.jobs = [];
    // A crash during processing leaves jobs "processing": put them back as retrying.
    for (const job of this.jobs) if (job.status === 'processing') { job.status = 'retrying'; job.runAt = this.now(); job.log.push(this.entry('Recovered after an unexpected shutdown.')); }
    await this.persist();
    return this;
  }

  entry(message, level = 'info') { return { at: new Date(this.now()).toISOString(), level, message: String(message).slice(0, 2000) }; }

  async persist() {
    // keep the 500 most recent finished jobs
    const active = this.jobs.filter((j) => !FINAL.has(j.status));
    const finished = this.jobs.filter((j) => FINAL.has(j.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
    this.jobs = [...active, ...finished];
    await atomicWrite(this.file, JSON.stringify(this.jobs));
  }

  /** job: { source, kind, payload, runAt?, maxAttempts?, retryDelayMs?, requireApproval?, description } */
  async add(spec) {
    const now = this.now();
    const job = {
      id: randomUUID(), source: spec.source, kind: spec.kind, description: String(spec.description || '').slice(0, 300),
      payload: spec.payload, status: spec.requireApproval ? 'awaiting-approval' : (spec.runAt && spec.runAt > now ? 'scheduled' : 'queued'),
      runAt: spec.runAt || now, attempts: 0, maxAttempts: Math.max(1, Math.min(10, Number(spec.maxAttempts) || 1)),
      retryDelayMs: Math.max(1000, Math.min(3600_000, Number(spec.retryDelayMs) || 30_000)),
      createdAt: now, updatedAt: now, result: null, error: '', log: [this.entry('Job created (' + spec.source + ').')]
    };
    this.jobs.unshift(job);
    await this.persist();
    this.deps.onChange?.(job);
    this.kick();
    return job;
  }

  get(id) { return this.jobs.find((j) => j.id === id) || null; }
  list() { return this.jobs.slice(0, 200); }

  async update(id, patch, message, level) {
    const job = this.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: this.now() });
    if (message) { job.log.push(this.entry(message, level)); this.deps.log?.({ jobId: id, level: level || 'info', message }); }
    if (job.log.length > 100) job.log = job.log.slice(-100);
    await this.persist();
    this.deps.onChange?.(job);
    return job;
  }

  async approve(id) {
    const job = this.get(id);
    if (!job || job.status !== 'awaiting-approval') return null;
    const now = this.now();
    const updated = await this.update(id, { status: job.runAt > now ? 'scheduled' : 'queued' }, 'Approved by the user.');
    this.kick();
    return updated;
  }

  async reject(id) {
    const job = this.get(id);
    if (!job || FINAL.has(job.status) || job.status === 'processing') return null;
    const updated = await this.update(id, { status: 'rejected' }, 'Rejected by the user.', 'warning');
    await this.deps.onFinal?.(updated);
    return updated;
  }

  async cancel(id) {
    const job = this.get(id);
    if (!job || FINAL.has(job.status) || job.status === 'processing') return null;
    const updated = await this.update(id, { status: 'cancelled' }, 'Cancelled.', 'warning');
    await this.deps.onFinal?.(updated);
    return updated;
  }

  start(intervalMs = 1000) {
    this.stopped = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref?.();
    this.kick();
  }

  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }

  next() {
    const now = this.now();
    return this.jobs.filter((j) => (j.status === 'queued' || j.status === 'scheduled' || j.status === 'retrying') && j.runAt <= now)
      .sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt)[0];
  }

  kick() {
    if (this.running || this.stopped) return this.idle;
    const job = this.next();
    if (!job) return Promise.resolve();
    this.running = true;
    this.idle = this.process(job).finally(() => { this.running = false; setImmediate(() => this.kick()); });
    return this.idle;
  }

  async process(job) {
    const attempt = job.attempts + 1;
    await this.update(job.id, { status: 'processing', attempts: attempt }, 'Processing (attempt ' + attempt + ' of ' + job.maxAttempts + ').');
    try {
      const result = await this.deps.execute(job);
      const done = await this.update(job.id, { status: 'done', result, error: '' }, result?.summary || 'Completed.');
      await this.deps.onFinal?.(done);
    } catch (error) {
      const message = error?.message || String(error);
      const retryable = error?.retryable !== false && attempt < job.maxAttempts;
      if (retryable) {
        await this.update(job.id, { status: 'retrying', error: message, runAt: this.now() + job.retryDelayMs }, 'Failed: ' + message + ' — retrying in ' + Math.round(job.retryDelayMs / 1000) + ' s.', 'warning');
      } else {
        const failed = await this.update(job.id, { status: 'failed', error: message }, 'Failed: ' + message, 'error');
        await this.deps.onFinal?.(failed);
      }
    }
  }
}

module.exports = { JobQueue, FINAL };
