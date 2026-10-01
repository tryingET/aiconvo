'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const S = require('../delegation-store');

// Execute the original fixture and after-hook, not a copy of its cleanup.
async function controlledFixture(t, { owner = 'supervisorIdentity', unknown = false, pipeError = false, retry = false } = {}) {
  let cleanup, holder, closed = false, observed = 0, removals = 0, problem = '';
  const store = { ...S, allIds: () => ['fixture-task'], sameProcess: saved => {
    observed++;
    if (unknown) { problem = 'controlled identity observation failed'; return false; }
    if (holder.connected) holder.send('release');
    return S.sameProcess(saved);
  } };
  const task = { status: owner === 'processIdentity' ? 'lost' : 'succeeded', error: pipeError ? 'Worker exited but descendant output pipes remained open; descendant outcome is unknown' : null };
  const delegation = { getDelegation: async () => task, listDelegations: async () => [task], controlDelegation: async () => assert.fail('terminal work must not be signalled') };
  const filesystem = { ...fs, rmSync: (dir, options) => {
    removals++;
    // Unix permits unlinking an open file; Windows refuses this holder.
    if (S.sameProcess(task[owner])) throw Object.assign(Error('EPERM: fixture holder still alive at removal'), { code: 'EPERM' });
    assert.ok(observed > 0, 'removal must follow an exit observation');
    if (retry) {
      assert.ok(options.maxRetries > 0 && options.retryDelay > 0, 'post-exit Windows removal needs bounded retries');
    }
    return fs.rmSync(dir, options);
  } };
  const source = fs.readFileSync(path.join(__dirname, 'delegation.test.js'), 'utf8');
  const localRequire = id => id === 'node:test' ? () => {} : id === 'node:fs' ? filesystem : id === '../delegation' ? delegation : id === '../delegation-store' ? store : id === '../processes' || id === '../processes.js' ? { identityProblem: () => problem } : require(id);
  localRequire.resolve = require.resolve;
  const context = vm.createContext({ require: localRequire, __dirname, process, setTimeout, clearTimeout, console });
  vm.runInContext(source + '\nthis.fixtureUnderTest = fixture;', context, { filename: 'delegation.test.js' });
  const f = await context.fixtureUnderTest({ after: hook => { cleanup = hook; } });
  holder = spawn(process.execPath, ['-e',
    "const fs=require('fs'); const fd=fs.openSync(process.argv[1],'a'); process.send('terminal'); process.once('message',()=>{fs.closeSync(fd);process.disconnect();});",
    path.join(f.dir, 'held.log')], { cwd: f.dir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const joined = once(holder, 'close').then(() => { closed = true; });
  t.after(async () => {
    if (!closed) holder.kill('SIGKILL');
    await joined;
    fs.rmSync(f.dir, { recursive: true, force: true });
  });
  await once(holder, 'message'); // Terminal publication with the real log/cwd still held.
  task[owner] = S.identity(holder.pid);
  assert.ok(task[owner]);
  return { cleanup, f, joined, removals: () => removals, observed: () => observed };
}

test('terminal publication joins the supervisor holding its fixture before Windows-style removal', async t => {
  const c = await controlledFixture(t);
  await c.cleanup();
  await c.joined;
  assert.ok(c.observed() > 0);
  assert.equal(fs.existsSync(c.f.dir), false);
});

test('a terminal lost worker is joined without signalling its saved PID', async t => {
  const c = await controlledFixture(t, { owner: 'processIdentity' });
  await c.cleanup();
  await c.joined;
  assert.equal(fs.existsSync(c.f.dir), false);
});

test('unavailable process identity retains the fixture without attempting removal', async t => {
  const c = await controlledFixture(t, { unknown: true });
  await assert.rejects(c.cleanup(), /controlled identity observation failed/);
  assert.equal(c.removals(), 0);
  assert.equal(fs.existsSync(c.f.dir), true);
});

test('unknown descendant output writers retain the fixture', async t => {
  const c = await controlledFixture(t, { pipeError: true });
  await assert.rejects(c.cleanup(), /descendant outcome is unknown/);
  assert.equal(c.removals(), 0);
  assert.equal(fs.existsSync(c.f.dir), true);
});

test('post-join removal requests bounded Windows retries', async t => {
  const c = await controlledFixture(t, { retry: true });
  await c.cleanup();
  await c.joined;
  assert.equal(c.removals(), 1);
});
