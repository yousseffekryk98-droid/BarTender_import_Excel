'use strict';
// Watch-folder ("File Drop") automation: polls an Incoming folder, waits until each file has
// stopped changing, claims it atomically, and moves it to Completed or Error afterwards.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ALLOWED = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.json'];
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PROCESSING = '.els-processing';

function patternToRegex(pattern) {
  const parts = String(pattern || '*.xlsx;*.xls;*.csv').split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  const re = parts.map((p) => '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').join('|');
  return new RegExp(re || '^$', 'i');
}

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function moveFile(source, targetDir, name) {
  await fs.mkdir(targetDir, { recursive: true });
  let target = path.join(targetDir, stamp() + '__' + safeName(name));
  for (let i = 1; ; i++) {
    try { await fs.access(target); target = path.join(targetDir, stamp() + '_' + i + '__' + safeName(name)); }
    catch { break; }
  }
  try { await fs.rename(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
  return target;
}

/** Validate a folder rule's paths: absolute, distinct, not nested inside each other. */
function validateRuleFolders(rule) {
  const names = ['incoming', 'completed', 'error'];
  for (const key of names) {
    if (typeof rule[key] !== 'string' || !path.isAbsolute(rule[key])) throw new Error('The ' + key + ' folder must be an absolute path.');
  }
  const resolved = names.map((k) => path.resolve(rule[k]).toLowerCase());
  if (new Set(resolved).size !== resolved.length) throw new Error('Incoming, Completed and Error must be different folders.');
  const inc = resolved[0] + path.sep;
  if (resolved.slice(1).some((p) => (p + path.sep).startsWith(inc))) throw new Error('Completed and Error folders must not be inside the Incoming folder.');
  return true;
}

class FolderWatcher {
  /** deps: { rules() → [rule], onFile({ rule, claimedPath, originalName, size }) → Promise, log(entry), intervalMs, stableMs } */
  constructor(deps) {
    this.deps = deps;
    this.seen = new Map();
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.scan().catch((error) => this.deps.log?.({ level: 'error', message: 'Folder scan failed: ' + error.message })), this.deps.intervalMs || 2000);
    this.timer.unref?.();
    return this.scan();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async scan() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const rule of this.deps.rules().filter((r) => r.enabled)) {
        try { validateRuleFolders(rule); } catch (error) { this.deps.log?.({ level: 'error', rule: rule.name, message: error.message }); continue; }
        await fs.mkdir(rule.incoming, { recursive: true }).catch(() => {});
        const matcher = patternToRegex(rule.pattern);
        let names = [];
        try { names = await fs.readdir(rule.incoming); } catch (error) { this.deps.log?.({ level: 'error', rule: rule.name, message: 'Cannot read ' + rule.incoming + ': ' + error.message }); continue; }
        for (const name of names) {
          if (name.startsWith('.') || name.startsWith('~$') || !matcher.test(name)) continue;
          const full = path.join(rule.incoming, name);
          let info;
          try { info = await fs.lstat(full); } catch { continue; }
          if (!info.isFile() || info.isSymbolicLink()) continue;
          const key = rule.id + '|' + name;
          const previous = this.seen.get(key);
          const now = Date.now();
          if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) { this.seen.set(key, { size: info.size, mtimeMs: info.mtimeMs, since: now }); continue; }
          if (now - previous.since < (this.deps.stableMs ?? 2000)) continue;
          this.seen.delete(key);
          await this.claim(rule, full, name, info.size);
        }
      }
    } finally { this.busy = false; }
  }

  async claim(rule, full, name, size) {
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED.includes(ext)) return;
    const processingDir = path.join(rule.incoming, PROCESSING);
    await fs.mkdir(processingDir, { recursive: true });
    const claimed = path.join(processingDir, randomUUID() + '__' + safeName(name));
    try { await fs.rename(full, claimed); }
    catch (error) { this.deps.log?.({ level: 'warning', rule: rule.name, message: 'Could not claim ' + name + ' (' + error.code + '); it may still be open in another program.' }); return; }
    if (size > MAX_FILE_BYTES) {
      const moved = await moveFile(claimed, rule.error, name);
      await fs.writeFile(moved + '.log.txt', 'Rejected: file is larger than 50 MB.\n');
      this.deps.log?.({ level: 'error', rule: rule.name, message: name + ' rejected: larger than 50 MB.' });
      return;
    }
    this.deps.log?.({ level: 'info', rule: rule.name, message: 'Picked up ' + name + '.' });
    await this.deps.onFile({ rule, claimedPath: claimed, originalName: name, size });
  }
}

/** Finish a claimed file: move to Completed or Error (with a log next to it). */
async function finishFile({ rule, claimedPath, originalName }, ok, logText) {
  const target = await moveFile(claimedPath, ok ? rule.completed : rule.error, originalName);
  if (!ok || logText) await fs.writeFile(target + '.log.txt', String(logText || '') + '\n').catch(() => {});
  return target;
}

module.exports = { FolderWatcher, finishFile, patternToRegex, validateRuleFolders, moveFile, PROCESSING, ALLOWED };
