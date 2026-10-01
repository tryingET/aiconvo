'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { localMachinesCleanup } = require('./localmachines-browser-cleanup');

test('Given one uncertain server writer and an independent successful close, When teardown aggregates results, Then the other close runs but shared storage is retained', async () => {
  let hook, removed = false, otherJoined = false;
  const failure = new Error('writer exit uncertain');
  const cleanup = localMachinesCleanup({ after: fn => hook = fn }, async () => removed = true);
  cleanup.addWriter(async () => { otherJoined = true; });
  cleanup.addWriter(async () => { throw failure; });
  await assert.rejects(hook(), error => error === failure);
  assert.equal(otherJoined, true);
  assert.equal(removed, false);
});

test('Given a scenario failure but all declared writers join, When teardown settles, Then independent shared removal still happens and the original failure survives', async () => {
  let hook, removed = false, writerJoined = false;
  const failure = new Error('browser scenario failure');
  const cleanup = localMachinesCleanup({ after: fn => hook = fn }, async () => removed = true);
  cleanup.addWriter(async () => { writerJoined = true; });
  cleanup.add(async () => { throw failure; });
  await assert.rejects(hook(), error => error === failure);
  assert.equal(writerJoined, true);
  assert.equal(removed, true);
});
