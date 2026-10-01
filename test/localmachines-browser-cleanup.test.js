'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { stopAndRemove } = require('./helpers/cleanup');
const { closeLocalBrowser, localMachinesCleanup } = require('./localmachines-browser-cleanup');

async function fixture(t) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-shutdown-')));
  const browser = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('message', () => { fs.writeFileSync(process.argv[1] + '/final-write', 'closed'); process.exit(0); });
    process.send('ready');
  `, profile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => stopAndRemove(browser, profile));
  await new Promise((resolve, reject) => { browser.once('message', resolve); browser.once('error', reject); });
  const ws = new EventTarget(); ws.readyState = 1;
  ws.close = () => { ws.readyState = 3; ws.dispatchEvent(new Event('close')); };
  return { browser, profile, ws };
}

for (const failure of ['hang/no reply', 'disconnect', 'CDP error', 'CDP rejection', 'CDP throw', 'already disconnected']) {
  test(`Given a browser with ${failure}, When graceful shutdown fails, Then fallback joins exit and profile removal within the existing deadline`, { timeout: 120000 }, async t => {
    const f = await fixture(t);
    if (failure === 'already disconnected') f.ws.close();
    const closeBrowser = () => {
      if (failure === 'disconnect') f.ws.close();
      if (failure === 'CDP rejection') return Promise.reject(new Error('controlled CDP rejection'));
      if (failure === 'CDP throw') throw new Error('controlled CDP throw');
      if (failure === 'CDP error') return Promise.resolve({ error: { message: 'controlled CDP failure' } });
      return new Promise(() => {});
    };
    // A watchdog is a RED oracle, not the graceful-shutdown implementation.
    let watchdog;
    const done = closeLocalBrowser({ ...f, closeBrowser, graceMs: 0 });
    const guarded = Promise.race([done, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('unbounded graceful wait')), 1000); })]);
    try {
      await assert.rejects(guarded, error => {
        assert.match(error.message, /local browser shutdown:/);
        assert.doesNotMatch(error.message, /fallback returned before browser exit|exit was not observed/);
        return true;
      });
      assert.ok(f.browser.exitCode !== null || f.browser.signalCode !== null, 'fallback actually stopped the live browser');
      assert.equal(fs.existsSync(f.profile), false, 'all profile removal is joined before rejection');
      assert.equal(f.browser.listenerCount('exit'), 0, 'no graceful waiter survives fallback');
    } finally {
      clearTimeout(watchdog);
      await stopAndRemove(f.browser, f.profile);
      await done.catch(() => {});
    }
  });
}

test('Given Chrome exits normally without a CDP reply, When shutdown joins its exit, Then no forced shutdown is reported', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const result = await closeLocalBrowser({ ...f, closeBrowser: () => { f.browser.send('finish'); return new Promise(() => {}); } });
  assert.equal(result.graceful, true);
  assert.equal(f.browser.exitCode, 0); assert.equal(f.browser.signalCode, null);
  assert.equal(fs.existsSync(f.profile), false);
});

test('Given a primary scenario failure and disconnected CDP, When fallback completes, Then the original failure carries cleanup diagnostics', { timeout: 120000 }, async t => {
  const f = await fixture(t); f.ws.close();
  const primaryError = new Error('primary scenario assertion');
  await assert.rejects(closeLocalBrowser({ ...f, primaryError, closeBrowser: () => {}, graceMs: 0 }), error => error === primaryError && /primary scenario assertion/.test(error.message) && /local browser shutdown:/.test(error.message));
  assert.equal(fs.existsSync(f.profile), false);
});


test('Given primary and removal failures, When fallback rejects, Then neither failure is lost', { timeout: 120000 }, async t => {
  const f = await fixture(t); f.ws.close();
  const primaryError = new Error('primary assertion'), removalError = new Error('controlled removal failure');
  await assert.rejects(closeLocalBrowser({ ...f, primaryError, graceMs: 0 }, {
    remove: async (...args) => { await stopAndRemove(...args); throw removalError; },
  }), error => error === primaryError && error.cleanupDiagnostics.includes(removalError) && /controlled removal failure/.test(error.message));
  assert.equal(fs.existsSync(f.profile), false);
});


test('Given browser teardown fails, When the fixture hook runs, Then remaining resources are joined before the original failure is rethrown', { timeout: 120000 }, async t => {
  const f = await fixture(t); f.ws.close();
  const primaryError = new Error('primary failure');
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-other-'));
  t.after(() => stopAndRemove(null, otherHome));
  let hook, serverJoined = false;
  const cleanup = localMachinesCleanup({ after: fn => hook = fn }, () => stopAndRemove(null, otherHome));
  cleanup.add(async () => { serverJoined = true; });
  cleanup.add(() => closeLocalBrowser({ ...f, primaryError, graceMs: 0 }));
  await assert.rejects(hook(), error => error === primaryError);
  assert.equal(serverJoined, true);
  assert.equal(fs.existsSync(otherHome), false);
  assert.equal(fs.existsSync(f.profile), false);
});

// Controlled CDP boundary: no Chrome timing assumption is part of these oracles.
function targetFixture() {
  const { EventEmitter } = require('node:events');
  const browser = new EventEmitter(); browser.exitCode = browser.signalCode = null;
  const ws = new EventTarget(); ws.readyState = 1;
  ws.close = () => { ws.readyState = 3; ws.dispatchEvent(new Event('close')); };
  const calls = [];
  const ownedTarget = { targetId: 'owned-tab', sessionId: 'owned-session', send: async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    return { result: method === 'Target.closeTarget' ? { success: true } : {} };
  } };
  const closeBrowser = () => {
    calls.push({ method: 'Browser.close' });
    browser.exitCode = 0; browser.emit('exit', 0, null);
    return new Promise(() => {});
  };
  let removed = 0;
  const remove = async () => {
    removed++;
    if (browser.exitCode === null) { browser.signalCode = 'SIGKILL'; browser.emit('exit', null, 'SIGKILL'); }
  };
  return { browser, ws, calls, ownedTarget, closeBrowser, remove, removed: () => removed };
}
const flushCDP = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('Given one known owned tab and session, When shutdown begins, Then root CDP detaches that session and closes only that tab before exactly one Browser.close', async () => {
  const f = targetFixture();
  assert.deepEqual(await closeLocalBrowser(f, { remove: f.remove }), { graceful: true });
  assert.deepEqual(f.calls, [
    { method: 'Target.detachFromTarget', params: { sessionId: 'owned-session' }, sessionId: undefined },
    { method: 'Target.closeTarget', params: { targetId: 'owned-tab' }, sessionId: undefined },
    { method: 'Browser.close' },
  ]);
  assert.equal(f.browser.exitCode, 0); assert.equal(f.browser.signalCode, null);
  assert.equal(f.removed(), 1);
});

test('Given a created tab but attachment did not finish, When shutdown begins, Then only that known tab is closed before Browser.close', async () => {
  const f = targetFixture(); delete f.ownedTarget.sessionId;
  await closeLocalBrowser(f, { remove: f.remove });
  assert.deepEqual(f.calls.map(c => c.method), ['Target.closeTarget', 'Browser.close']);
  assert.deepEqual(f.calls[0].params, { targetId: 'owned-tab' });
});

for (const failure of ['detach error', 'close false', 'send rejection', 'send throw']) {
  test(`Given owned-target cleanup returns ${failure}, When shutdown joins normal exit, Then Browser.close is still requested once but the cleanup failure remains visible`, async () => {
    const f = targetFixture(), send = f.ownedTarget.send;
    f.ownedTarget.send = (method, ...args) => {
      const reply = send(method, ...args);
      if (method === 'Target.detachFromTarget' && failure === 'detach error') return { error: { message: 'controlled detach failure' } };
      if (method === 'Target.closeTarget') {
        if (failure === 'close false') return { result: { success: false } };
        if (failure === 'send rejection') return Promise.reject(new Error('controlled target rejection'));
        if (failure === 'send throw') throw new Error('controlled target throw');
      }
      return reply;
    };
    await assert.rejects(closeLocalBrowser(f, { remove: f.remove }), /local browser shutdown:.*(Target\.|controlled target)/);
    assert.deepEqual(f.calls.map(c => c.method), ['Target.detachFromTarget', 'Target.closeTarget', 'Browser.close']);
    assert.equal(f.browser.exitCode, 0); assert.equal(f.browser.signalCode, null);
    assert.equal(f.removed(), 1);
  });
}

for (const stalled of ['Target.detachFromTarget', 'Target.closeTarget']) {
  test(`Given ${stalled} stalls, When the original 3000ms window expires, Then fallback joins and a late reply cannot send more CDP requests`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = targetFixture(), send = f.ownedTarget.send; let reply;
    f.ownedTarget.send = (method, ...args) => {
      const result = send(method, ...args);
      return method === stalled ? new Promise(resolve => reply = resolve) : result;
    };
    const done = closeLocalBrowser(f, { remove: f.remove });
    const rejected = assert.rejects(done, /graceful window expired/);
    await flushCDP(); t.mock.timers.tick(2999); await flushCDP();
    const beforeExpiry = f.removed();
    t.mock.timers.tick(1); await rejected;
    assert.equal(beforeExpiry, 0, 'no premature fallback');
    const atExpiry = [...f.calls];
    reply({ result: { success: true } }); await flushCDP();
    assert.deepEqual(f.calls, atExpiry, 'no late close races fallback or profile deletion');
    assert.equal(f.removed(), 1); assert.equal(f.browser.listenerCount('exit'), 0);
  });
}

test('Given target cleanup finishes at 2999ms but Browser.close has no exit, When the remaining 1ms expires, Then no fresh graceful window is granted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = targetFixture(), send = f.ownedTarget.send; let detach;
  f.ownedTarget.send = (method, ...args) => {
    const reply = send(method, ...args);
    return method === 'Target.detachFromTarget' ? new Promise(resolve => detach = resolve) : reply;
  };
  f.closeBrowser = () => { f.calls.push({ method: 'Browser.close' }); return new Promise(() => {}); };
  const rejected = assert.rejects(closeLocalBrowser(f, { remove: f.remove }), /graceful window expired/);
  t.mock.timers.tick(2999); detach?.({ result: {} }); await flushCDP();
  const beforeExpiry = f.removed(), methods = f.calls.map(c => c.method);
  t.mock.timers.tick(1); await rejected;
  assert.deepEqual(methods, ['Target.detachFromTarget', 'Target.closeTarget', 'Browser.close']);
  assert.equal(beforeExpiry, 0); assert.equal(f.removed(), 1);
});

for (const outcome of ['normal exit', 'disconnect']) {
  test(`Given CDP detachment is pending at ${outcome}, When shutdown settles, Then its late reply cannot close targets after profile removal`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = targetFixture(); let reply;
    f.ownedTarget.send = (method, params) => { f.calls.push({ method, params }); return new Promise(resolve => reply = resolve); };
    const done = closeLocalBrowser(f, { remove: f.remove });
    const checked = outcome === 'disconnect' ? assert.rejects(done, /graceful window expired after CDP disconnected/) : done;
    if (outcome === 'normal exit') { f.browser.exitCode = 0; f.browser.emit('exit', 0, null); }
    else { f.ws.close(); t.mock.timers.tick(3000); }
    await checked;
    assert.equal(f.removed(), 1);
    const atSettlement = [...f.calls];
    reply?.({ result: {} }); await flushCDP();
    assert.deepEqual(f.calls, atSettlement);
    assert.equal(f.browser.listenerCount('exit'), 0);
  });
}

test('Given no created target is known yet, When startup cleanup runs, Then no targets are discovered or closed and Browser.close is requested once', async () => {
  const f = targetFixture(); delete f.ownedTarget.targetId;
  await closeLocalBrowser(f, { remove: f.remove });
  assert.deepEqual(f.calls, [{ method: 'Browser.close' }]);
});

for (const terminal of ['timeout', 'Browser.close error']) {
  test(`Given a target preparation error followed by ${terminal}, When fallback settles, Then both diagnostics survive`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = targetFixture(), send = f.ownedTarget.send;
    f.ownedTarget.send = (method, ...args) => method === 'Target.detachFromTarget'
      ? { error: { message: 'controlled detach failure' } } : send(method, ...args);
    f.closeBrowser = () => terminal === 'timeout' ? new Promise(() => {})
      : { error: { message: 'controlled browser failure' } };
    const checked = assert.rejects(closeLocalBrowser(f, { remove: f.remove }), error => {
      assert.match(error.message, /controlled detach failure/);
      assert.match(error.message, /graceful window expired|controlled browser failure/);
      assert.equal(error.cleanupDiagnostics[0].errors.length, 2);
      return true;
    });
    await flushCDP(); if (terminal === 'timeout') t.mock.timers.tick(3000);
    await checked;
    assert.equal(f.removed(), 1);
  });
}
