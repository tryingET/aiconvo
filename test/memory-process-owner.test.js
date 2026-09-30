'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createProcessOwner } = require('../memory-process-owner');

// Execute the real Darwin platform adapter against a synthetic ps/sysctl API.
// This proves the portable ownership path, not execution on a Mac runner.
function macFixture() {
  const rows = new Map([
    [10, { ppid: 1, pgrp: 10, start: 'Wed Sep 30 20:00:00 2026' }],
    [11, { ppid: 10, pgrp: 10, start: 'Wed Sep 30 20:00:01 2026' }],
    [12, { ppid: 11, pgrp: 12, start: 'Wed Sep 30 20:00:02 2026' }],
    [99, { ppid: 1, pgrp: 99, start: 'Wed Sep 30 20:00:03 2026' }],
  ]);
  let unreadable = null;
  const apiProcess = { platform: 'darwin', env: {}, kill(pid) { if (!rows.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } };
  const childProcess = { execFileSync(command, args) {
    if (command === 'sysctl') return '{ sec = 123, usec = 0 }';
    assert.equal(command, 'ps');
    if (args.includes('-axww')) return [...rows].map(([pid, p]) => `${pid} ${p.ppid} ${p.pgrp} node synthetic`).join('\n');
    const pid = Number(args.at(-1));
    if (pid === unreadable) throw new Error('synthetic ps inaccessible');
    const p = rows.get(pid); if (!p) throw Object.assign(new Error('gone'), { status: 1 });
    return `${p.start} ${p.pgrp} S${args[1].includes('ppid=') ? ' ' + p.ppid : ''}`;
  } };
  const context = { module: { exports: {} }, process: apiProcess, require(name) { return name === 'child_process' ? childProcess : require(name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../processes.js'), 'utf8'), context);
  const signals = [], owner = createProcessOwner(context.module.exports, (pid, signal) => { signals.push([pid, signal]); rows.delete(pid); });
  return { rows, signals, owner, unreadable(pid) { unreadable = pid; } };
}

test('portable Darwin owner captures and terminates a separately detached child, never the unrelated process', () => {
  const s = macFixture(), anchor = s.owner.anchor(10);
  s.owner.capture(anchor, Infinity);
  assert.deepEqual(s.owner.owned.map(p => p.pid), [12, 11, 10]);
  assert.equal(s.owner.signal('SIGKILL', Infinity), true);
  assert.deepEqual(s.signals, [[12, 'SIGKILL'], [11, 'SIGKILL'], [10, 'SIGKILL']]);
  assert.equal(s.rows.has(99), true); assert.equal(s.owner.alive(anchor), false);
});

test('portable Darwin owner leaves a reused captured PID alone and rejects unknown live identity', () => {
  const s = macFixture(), anchor = s.owner.anchor(10); s.owner.capture(anchor, Infinity);
  s.rows.get(12).start = 'Wed Sep 30 20:01:02 2026';
  assert.equal(s.owner.signal('SIGKILL', Infinity), true);
  assert.equal(s.signals.some(([pid]) => pid === 12), false); assert.equal(s.rows.has(12), true);
  const unknown = macFixture(), a = unknown.owner.anchor(10); unknown.owner.capture(a, Infinity); unknown.unreadable(12);
  assert.equal(unknown.owner.signal('SIGKILL', Infinity), false);
  assert.throws(() => unknown.owner.alive(a), /inaccessible/);
  assert.equal(unknown.rows.has(12), true);
});

test('portable owner rejects unavailable capability instead of guessing process groups', () => {
  const s = macFixture(), anchor = s.owner.anchor(10);
  // A missing current table cannot prove ancestry even with readable identities.
  const api = { reliable: false, identity: pid => ({ pid, start: '1', boot: '1' }), ownership: pid => ({ pid, start: '1', boot: '1', ppid: 1 }) };
  const owner = createProcessOwner(api, () => assert.fail('unproved process signalled'));
  const a = owner.anchor(10); assert.throws(() => owner.capture(a, Infinity), /ownership unavailable/);
  s.unreadable(10); assert.throws(() => s.owner.capture(anchor, Infinity), /inaccessible/);
});
