'use strict';
const { stopAndRemove } = require('./helpers/cleanup');

function gracefulExit(browser, ws, closeBrowser, graceMs, ownedTarget) {
  const start = Date.now();
  const trace = (event, detail = {}) => {
    if (process.env.CHATTERING_TEST_TRACE === '1') console.log('BROWSER-SHUTDOWN', JSON.stringify({ event, elapsedMs: Date.now() - start, pid: browser.pid, ...detail }));
  };
  return new Promise((resolve, reject) => {
    let settled = false, disconnected = false, targetError;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      browser.removeListener('exit', onExit);
      ws?.removeEventListener('close', onDisconnect);
      ws?.removeEventListener('error', onDisconnect);
      if (error && targetError && error !== targetError)
        error = new AggregateError([targetError, error], targetError.message + '; ' + error.message, { cause: error });
      trace('graceful settled', { error: error?.message, exitCode: browser.exitCode, signalCode: browser.signalCode });
      if (error) reject(error); else resolve();
    };
    const onExit = (code, signal) => finish(code === 0 && !signal ? targetError : new Error(`browser exited code=${code}, signal=${signal}`));
    // Chrome can drop CDP *before* normal exit. Still allow that exit within
    // the bounded window, but retain disconnect diagnostics if it never comes.
    const onDisconnect = event => { disconnected = true; trace('CDP ' + event.type); };
    const timer = setTimeout(() => finish(new Error('graceful window expired' + (disconnected ? ' after CDP disconnected' : ' without browser exit'))), graceMs);
    browser.once('exit', onExit);
    ws?.addEventListener('close', onDisconnect);
    ws?.addEventListener('error', onDisconnect);
    if (!closeBrowser || ws?.readyState !== 1) return finish(new Error('CDP unavailable/disconnected'));
    const requestBrowserClose = () => {
      if (settled) return;
      if (ws.readyState !== 1) return finish(new Error('CDP unavailable/disconnected'));
      try {
        // Never await the reply: a normal exit is proof even without one.
        trace('Browser.close request');
        Promise.resolve(closeBrowser()).then(reply => {
          trace('Browser.close reply', { error: reply?.error });
          if (reply?.error) finish(new Error('CDP Browser.close failed: ' + (reply.error.message || JSON.stringify(reply.error))));
        }, error => finish(error));
      } catch (error) { finish(error); }
    };
    // Falsifiable mitigation, not a Chrome diagnosis: release only the
    // fixture's recorded session/tab. Keep the startup blank target alive.
    // These requests share the timer above; late replies must not race fallback.
    const releaseOwnedTarget = async () => {
      const { send, targetId, sessionId } = ownedTarget;
      const requests = [];
      if (sessionId) requests.push(['Target.detachFromTarget', { sessionId }]);
      requests.push(['Target.closeTarget', { targetId }]);
      for (const [method, params] of requests) {
        if (settled) return;
        if (ws.readyState !== 1) return finish(new Error('CDP unavailable/disconnected'));
        try {
          trace(method + ' request', params);
          const reply = await send(method, params);
          if (settled) return;
          trace(method + ' reply', { error: reply?.error, success: reply?.result?.success });
          if (reply?.error) throw new Error('CDP ' + method + ' failed: ' + (reply.error.message || JSON.stringify(reply.error)));
          if (method === 'Target.closeTarget' && reply?.result?.success !== true) throw new Error('CDP Target.closeTarget did not confirm success');
        } catch (error) {
          if (settled) return;
          // Still request Browser.close after a target protocol failure, but
          // do not turn a failed preparation into a successful cleanup result.
          targetError ||= error;
        }
      }
      requestBrowserClose();
    };
    if (ownedTarget?.targetId) releaseOwnedTarget().catch(error => finish(error));
    else requestBrowserClose();
  });
}

async function closeLocalBrowser({ browser, profile, ws, closeBrowser, primaryError, graceMs = 3000, ownedTarget }, { remove = stopAndRemove } = {}) {
  const failures = []; let graceful = false;
  if (browser.exitCode === null && browser.signalCode === null) {
    try { await gracefulExit(browser, ws, closeBrowser, graceMs, ownedTarget); graceful = true; }
    catch (error) { failures.push(error); }
  } else if (browser.exitCode !== 0 || browser.signalCode) {
    failures.push(new Error(`browser already exited code=${browser.exitCode}, signal=${browser.signalCode}`));
  }
  try { ws?.close(); } catch (error) { failures.push(error); }
  // Always joined, including CDP errors, disconnects, and a browser hang.
  try { await remove(browser, profile); } catch (error) { failures.push(error); }
  if (browser.exitCode === null && browser.signalCode === null) failures.push(new Error('fallback returned before browser exit'));
  if (failures.length) {
    const diagnostic = 'local browser shutdown: ' + failures.map(e => e.message || String(e)).join('; ');
    const error = primaryError || new Error(diagnostic, { cause: failures[0] });
    if (primaryError) error.message += '\n' + diagnostic;
    error.cleanupDiagnostics = failures;
    throw error;
  }
  return { graceful };
}
// One failed shutdown must not prevent the other owned homes from closing.
function localMachinesCleanup(t, remove) {
  const closes = [];
  t.after(async () => {
    const failures = []; let writersJoined = true;
    for (const { close, writer } of closes.reverse()) {
      try { await close(); }
      catch (error) { failures.push(error); if (writer) writersJoined = false; }
    }
    // A browser scenario failure need not block independent server joins.
    // An uncertain server writer must retain their shared registration store.
    if (writersJoined) { try { await remove(); } catch (error) { failures.push(error); } }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'local-machine fixture cleanup failed');
  });
  return {
    add: close => closes.push({ close, writer: false }),
    addWriter: close => closes.push({ close, writer: true }),
  };
}
module.exports = { closeLocalBrowser, localMachinesCleanup };
