'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const P = require('../processes');
const { stopAndRemove } = require('./helpers/cleanup');
const { captureOwnedGroup, stopOwnedGroup } = require('./helpers/owned-process-group');

const writer = String.raw`
  const fs = require('node:fs'), path = require('node:path');
  const auth = path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json');
  const write = () => { fs.mkdirSync(path.dirname(auth), { recursive: true }); fs.writeFileSync(auth, '{"synthetic":true}'); };
  write(); setInterval(write, 20); process.send('ready');`;
const parent = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  child.once('message', () => process.send({ ready: true, descendant: child.pid }));
  process.on('message', () => {});`;
const ready = child => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(Error('fixture exited before ready'))); });

for (const alias of [false, true]) {
  test(`Given an env-only-home descendant in a private group${alias ? ' reached through an alias' : ''}, When fixture teardown settles, Then every owned process is gone and an unrelated sentinel naming the same home survives`, { skip: process.platform === 'win32' && 'Windows uses native taskkill trees, not POSIX process groups', timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-group-'));
    const real = path.join(root, 'real'), link = path.join(root, 'alias');
    fs.mkdirSync(real); if (alias) fs.symlinkSync(real, link, 'dir');
    const home = alias ? link : real;
    const child = spawn(process.execPath, ['-e', parent], { detached: true, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(home, '.pi/agent') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let group, sentinel;
    t.after(async () => {
      const failures = [];
      try {
        if (group) await stopOwnedGroup(child, group, Date.now() + 3000);
        else await stopAndRemove(child, null);
      } catch (error) { failures.push(error); }
      try { await stopAndRemove(sentinel, null); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'retain fixture after uncertain group cleanup');
      await stopAndRemove(null, root);
    });
    const started = await ready(child); group = captureOwnedGroup(child);
    const descendant = P.identity(started.descendant);
    assert.ok(descendant && descendant.pgrp === group.pid, 'genuine env-only writer belongs to the owned group');
    assert.ok(fs.existsSync(path.join(home, '.pi/agent/auth.json')));
    const cleanupHome = fs.realpathSync.native(home);
    sentinel = spawn(process.execPath, ['-e', "process.on('message', m => { if (m === 'ping') process.send('pong'); }); process.send('ready');", cleanupHome], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await ready(sentinel);
    await stopAndRemove(child, cleanupHome, { ownedGroup: group });
    assert.equal(P.identity(started.descendant), null, 'root exit alone must not hide a live descendant');
    assert.equal(fs.existsSync(home), false);
    assert.equal(fs.existsSync(real), false);
    assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
    const pong = new Promise((resolve, reject) => {
      sentinel.once('message', resolve);
      sentinel.once('exit', () => reject(Error('unrelated sentinel was stopped')));
    });
    sentinel.send('ping'); assert.equal(await pong, 'pong');
  });
}

test('Given an ordinary child sharing its requester group, When group ownership is captured, Then it is refused rather than signaling the requester', { skip: process.platform === 'win32' && 'POSIX group contract' }, async t => {
  const child = spawn(process.execPath, ['-e', "process.on('message', () => {}); process.send('ready');"], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => stopAndRemove(child, null));
  await ready(child);
  assert.throws(() => captureOwnedGroup(child), /verified private process group/);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
});

test('Given a verified private fixture group, When its owner IPC disappears without after hooks, Then the preload ends ordinary descendants while retaining their home', { skip: process.platform === 'win32' && 'POSIX owner-loss contract', timeout: 30000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'group-owner-loss-'));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/private-group-owner.js'), '-e', parent],
    { detached: true, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(home, '.pi/agent') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let group;
  t.after(async () => {
    if (group) await stopOwnedGroup(child, group, Date.now() + 3000);
    else await stopAndRemove(child, null);
    await stopAndRemove(null, home);
  });
  const started = await ready(child); group = captureOwnedGroup(child);
  const joined = require('./helpers/cleanup').exited(child, 3000);
  child.disconnect(); await joined;
  const until = Date.now() + 3000;
  while (P.identity(started.descendant)) {
    if (Date.now() >= until) assert.fail('owner loss left the env-only writer alive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(child.signalCode, 'SIGKILL');
  assert.ok(fs.existsSync(home), 'lease loss never deletes user data');
});
