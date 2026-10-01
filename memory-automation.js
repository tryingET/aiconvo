'use strict';

// Consent is user data, not a cache. All mutations are synchronous durable
// replace operations so no provider call can overtake its intent record.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MODES = ['legacy', 'off', 'changes-after-enable'];
const STATES = ['pending', 'running', 'interrupted', 'error', 'done'];
const revision = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 4096 && !['__proto__', 'constructor', 'prototype'].includes(key);

function validate(s) {
  if (!object(s) || s.v !== 1 || !MODES.includes(s.mode) || typeof s.epoch !== 'string' ||
      !s.epoch || !Number.isFinite(s.activatedAt) || s.activatedAt < 0 || !object(s.baseline) || !object(s.pending)) throw new Error('Invalid automation state');
  for (const [key, r] of Object.entries(s.baseline)) if (!safeKey(key) || !hash(r)) throw new Error('Invalid baseline revision');
  const provenance = p => object(p) && ['live-new', 'baseline-discovery', 'revision-change'].includes(p.kind) &&
    Number.isFinite(p.observedAt) && (p.kind !== 'live-new' ||
      ['originAt', 'birthtimeMs', 'creationEventAt', 'dev', 'ino'].every(k => Number.isFinite(p[k])));
  if (s.observations !== undefined && (!object(s.observations) || Object.values(s.observations).some(p => !provenance(p)))) {
    throw new Error('Invalid observation provenance');
  }
  for (const [key, p] of Object.entries(s.pending)) {
    if (!safeKey(key) || !object(p) || !hash(p.revision) || !STATES.includes(p.status) || !Number.isFinite(p.at) ||
        p.epoch !== s.epoch || !Array.isArray(p.completed) || p.completed.some(x => typeof x !== 'string') ||
        s.baseline[key] !== p.revision || (p.attemptRevision !== undefined && !hash(p.attemptRevision)) ||
        (p.provenance !== undefined && !provenance(p.provenance))) throw new Error('Invalid pending revision');
  }
  if (s.retired !== undefined && (!Array.isArray(s.retired) || s.retired.some(r => !object(r) || typeof r.epoch !== 'string' ||
      !Number.isFinite(r.activatedAt) || !object(r.pending) || Object.values(r.pending).some(p => !object(p) || !hash(p.revision) ||
        p.epoch !== r.epoch || !STATES.includes(p.status))))) throw new Error('Invalid retired automation records');
  return s;
}

function durableWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    // Windows does not generally allow opening/fsyncing directory handles.
    // The file is still fsynced and atomically replaced; do not promise POSIX directory durability there.
    try { fd = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(fd); }
    catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function createAutomation({ file, now = Date.now, write = durableWrite }) {
  let state = null, error = null, busy = null, neverEnabled = false;
  try { state = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { neverEnabled = e.code === 'ENOENT'; error = neverEnabled ? 'Automation state is missing; explicitly disable and enable to baseline.' : 'Automation state is unreadable or corrupt; explicitly disable and enable to baseline.'; }
  function save(next) {
    // A failed/partially durable write must not restore the absent-state legacy exception.
    neverEnabled = false;
    try { validate(next); write(file, next); state = next; error = null; }
    catch (e) { error = 'Automation state could not be persisted: ' + e.message; throw e; }
  }
  if (state && Object.values(state.pending).some(p => p.status === 'running')) {
    const next = structuredClone(state);
    for (const p of Object.values(next.pending)) if (p.status === 'running') {
      p.status = 'interrupted'; p.error = 'Provider effects are unknown after restart. No automatic replay.';
    }
    try { save(next); } catch {}
  }
  function verifyPersisted() {
    if (neverEnabled) {
      try { fs.lstatSync(file); }
      catch (e) { if (e.code === 'ENOENT') return; }
      neverEnabled = false;
      error = 'Automation state appeared outside this controller or became unreadable; disable and enable to baseline again.';
    }
    if (!state || error) return;
    try {
      const disk = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (JSON.stringify(disk) !== JSON.stringify(state)) throw new Error('state changed outside this controller');
    } catch { error = 'Automation state disappeared, changed externally, or became corrupt; disable and enable to baseline again.'; }
  }
  const active = () => { verifyPersisted(); return !error && state?.mode === 'changes-after-enable'; };
  function change(fn) { const next = structuredClone(state); fn(next); save(next); }
  function configurationAllowed(mode, consentMode = mode) {
    verifyPersisted();
    return (mode === 'legacy' && neverEnabled) || (!error && state?.mode === consentMode);
  }
  return {
    configurationAllowed,
    legacyAllowed: () => configurationAllowed('legacy'),
    // Called only on an explicit mode transition. Repeated settings saves must
    // not repair missing state or silently acquire consent.
    activate(mode, baseline = {}) {
      if (!MODES.includes(mode)) throw new Error('Invalid automation mode');
      const retired = structuredClone(state?.retired || []);
      if (state) {
        const pending = Object.fromEntries(Object.entries(state.pending).filter(([, p]) => p.status !== 'done')
          .map(([key, p]) => [key, p.status === 'running' ? { ...p, status: 'interrupted', error: 'Epoch retired during in-flight work; no automatic replay.' } : p]));
        if (Object.keys(pending).length) retired.push({ epoch: state.epoch, activatedAt: state.activatedAt, pending });
      }
      save({ v: 1, mode, epoch: crypto.randomUUID(), activatedAt: now(), baseline: { ...baseline }, observations: {}, pending: {}, retired });
    },
    observe(key, rev, { provenance = { kind: 'baseline-discovery', observedAt: now() } } = {}) {
      if (!active()) return;
      if (!safeKey(key) || !hash(rev)) throw new Error('Invalid source revision');
      if (state.baseline[key] === rev) return;
      change(s => {
        const known = Object.hasOwn(s.baseline, key);
        const old = s.pending[key];
        const latched = old && ['running', 'interrupted', 'error'].includes(old.status);
        s.baseline[key] = rev;
        s.observations ||= {};
        if (!known) s.observations[key] = provenance;
        if (known || provenance.kind === 'live-new') s.pending[key] = {
          revision: rev, epoch: s.epoch, at: now(), completed: latched ? [...old.completed] : [],
          provenance: known ? { kind: 'revision-change', observedAt: now() } : provenance,
          status: latched ? (old.status === 'error' ? 'error' : 'interrupted') : 'pending',
          ...(latched ? { attemptRevision: old.attemptRevision || old.revision,
            error: old.error || 'Source changed during an indeterminate call; explicit discard required.' } : {}),
        };
        else delete s.pending[key]; // Unknown historical/imported file: baseline only.
      });
    },
    ready(settleMs = 0) {
      if (!active() || busy) return [];
      return Object.entries(state.pending).filter(([, p]) => p.status === 'pending' && now() - p.at >= settleMs)
        .sort((a, b) => a[1].at - b[1].at).map(([key]) => key);
    },
    claim(key) {
      if (!active() || busy || state.pending[key]?.status !== 'pending') throw new Error('Automatic revision is not ready');
      const ticket = { key, epoch: state.epoch, revision: state.pending[key].revision };
      change(s => { s.pending[key].status = 'running'; s.pending[key].attemptRevision = ticket.revision; }); busy = ticket;
      return ticket;
    },
    check(ticket, currentRevision, configuredMode) {
      const p = state?.pending[ticket.key];
      if (!active() || configuredMode !== 'changes-after-enable' || ticket.epoch !== state.epoch ||
          p?.revision !== ticket.revision || p.status !== 'running' || currentRevision !== ticket.revision) {
        const e = new Error('Automatic consent or source revision changed; result not published'); e.code = 'STALE_AUTOMATION'; throw e;
      }
    },
    stage(ticket, stage) {
      if (!active() || state.epoch !== ticket.epoch || state.pending[ticket.key]?.revision !== ticket.revision ||
          state.pending[ticket.key].status !== 'running') throw new Error('Stale automatic stage');
      change(s => { if (!s.pending[ticket.key].completed.includes(stage)) s.pending[ticket.key].completed.push(stage); });
    },
    finish(ticket, failure = null) {
      if (busy === ticket) busy = null;
      if (!active() || state.epoch !== ticket.epoch || state.pending[ticket.key]?.revision !== ticket.revision ||
          state.pending[ticket.key].status !== 'running') return;
      change(s => { const p = s.pending[ticket.key]; p.status = failure ? 'error' : 'done'; if (failure) p.error = String(failure.message || failure); });
    },
    discard(key) {
      if (!active() || busy) throw new Error('Cannot discard while automatic work is running');
      if (!Object.hasOwn(state.pending, key)) throw new Error('Unknown pending revision');
      change(s => { s.pending[key].status = 'done'; s.pending[key].error = 'Explicitly discarded without inference; awaiting a future source change.'; });
    },
    status(mode, consentMode = mode) {
      return { mode, active: active() && mode === state.mode && consentMode === state.mode, epoch: state?.epoch || null,
        activatedAt: state?.activatedAt || null, baselineCount: Object.keys(state?.baseline || {}).length,
        error: configurationAllowed(mode, consentMode) ? null : error || 'Settings and consent state disagree; disable and enable again.',
        pending: Object.entries(state?.pending || {}).filter(([, p]) => p.status !== 'done').map(([key, p]) => ({ key, ...p })),
        retired: (state?.retired || []).flatMap(r => Object.entries(r.pending).map(([key, p]) => ({ key, ...p }))),
        observations: state?.observations || {},
        coverage: 'Live-created files qualify only with matching creation metadata and session-origin time after activation. Restart discovery, imports with old origin, and unknown metadata are baselined. Changed baselined sessions qualify and include old context. No automatic replay of interrupted/error work.' };
    },
  };
}
module.exports = { MODES, revision, validate, durableWrite, createAutomation };
