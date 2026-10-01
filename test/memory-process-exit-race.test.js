'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createProcessOwner } = require('../memory-process-owner');
const original = { pid: 10, start: 'old', boot: 'boot', ppid: 1 };

test('exit between ownership and identity reads requires fresh absence, not an uncertainty failure', () => {
  let reads = 0;
  const owner = createProcessOwner({ ownership: () => ++reads === 1 ? original : null, identity: () => null });
  assert.equal(owner.read(10), null);
  assert.equal(reads, 2, 'absence is confirmed with a fresh ownership read');
});

test('one-sided absence cannot authorize signalling a reused or unreadable PID', () => {
  let reads = 0;
  const replacement = { ...original, start: 'new' };
  const owner = createProcessOwner({ ownership: () => ++reads === 1 ? original : replacement, identity: () => null },
    () => assert.fail('uncertain process signalled'));
  assert.throws(() => owner.read(10), /identity unavailable/);
  const inaccessible = createProcessOwner({ ownership() { throw new Error('access denied'); }, identity: () => null });
  assert.throws(() => inaccessible.read(10), /access denied/);
});

test('Windows query failure counts as exit only when the kernel confirms ESRCH afterward', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../processes'), 'utf8');
  for (const outcome of ['gone', 'live', 'denied']) {
    let queried = false;
    const context = { module: { exports: {} }, process: { platform: 'win32', env: {}, kill() {
      if (queried && outcome !== 'live') throw Object.assign(new Error(outcome), { code: outcome === 'gone' ? 'ESRCH' : 'EPERM' });
    } }, require(name) { return name === 'child_process' ? { execFileSync() {
      queried = true; throw Object.assign(new Error('synthetic query failed'), { code: 'EIO' });
    } } : require(name); } };
    vm.runInNewContext(source, context);
    if (outcome === 'gone') assert.equal(context.module.exports.ownership(10), null);
    else assert.throws(() => context.module.exports.ownership(10), error => error.code === 'EIO', outcome);
  }
});
