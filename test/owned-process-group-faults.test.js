'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function fixture({ readError, exited = false, exitDuringRead = false, expireDuringRead = false, clockStart = 0 } = {}) {
  let clock = clockStart, observations = 0;
  const signals = [];
  const child = { pid: 777, exitCode: exited ? 0 : null, signalCode: null };
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[2] = '777'; fields[19] = '123';
  const box = { module: { exports: {} }, Date: { now: () => clock }, setTimeout, clearTimeout,
    process: { platform: 'linux', pid: 222, kill: (...args) => signals.push(args) },
    require: name => {
      if (name === '../../processes') return { identity: () => null };
      if (name === 'node:child_process') return { execFile: (_cmd, _args, _opts, callback) => {
        observations++; callback(null, '222 100 S\n888 777 S\n');
      } };
      if (name === 'node:fs/promises') return { readFile: async p => {
        if (readError) throw Object.assign(Error('controlled identity observation failure'), { code: readError });
        if (expireDuringRead) clock = 101;
        if (exitDuringRead) child.exitCode = 0;
        return p.endsWith('boot_id') ? 'boot\n' : '777 (fixture) ' + fields.join(' ');
      } };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'helpers/owned-process-group.js'), 'utf8'), box);
  return { stop: deadline => box.module.exports.stopOwnedGroup(
    child, { pid: 777, pgrp: 777, start: '123', boot: 'boot' }, deadline),
    signals, observations: () => observations };
}

for (const code of ['ENOENT', 'EACCES']) {

  test(`Given leader observation fails with ${code}, When numeric group members remain, Then uncertainty never authorizes a signal`, async () => {
    const f = fixture({ readError: code });
    await assert.rejects(f.stop(100), /controlled identity observation failure/);
    assert.deepEqual(f.signals, []);
  });
}

test('Given a separately observed root exit and remaining numeric group rows, When teardown is requested, Then a historical token cannot signal the group', async () => {
  const f = fixture({ exited: true });
  await assert.rejects(f.stop(100), /leader already exited/);
  assert.deepEqual(f.signals, []);
});

test('Given an already expired stop budget, When cleanup starts, Then it neither observes nor signals', async () => {
  const f = fixture({ clockStart: 101 });
  await assert.rejects(f.stop(100), /deadline expired/);
  assert.equal(f.observations(), 0);
  assert.deepEqual(f.signals, []);
});

test('Given valid identity observation uses the remaining budget, When it completes after expiry, Then no late destructive action starts', async () => {
  const f = fixture({ expireDuringRead: true });
  await assert.rejects(f.stop(100), /deadline expired/);
  assert.deepEqual(f.signals, []);
});

test('Given exit is observed while a matching identity query is pending, When the query resolves, Then cached exit is rechecked before signaling', async () => {
  const f = fixture({ exitDuringRead: true });
  await assert.rejects(f.stop(100), /leader exited during observation/);
  assert.deepEqual(f.signals, []);
});
