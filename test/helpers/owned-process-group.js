'use strict';
// Fixture-only: ordinary descendants in a directly spawned private POSIX
// group. Historical leader identity never authorizes a missing/reused leader.
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const P = require('../../processes');

function captureOwnedGroup(child) {
  if (process.platform === 'win32') throw Error('POSIX process groups are unavailable');
  const id = P.identity(child?.pid); // startup preflight, not stop-time authority
  if (!id || id.pid === process.pid || id.pgrp !== child.pid)
    throw Error('fixture child must lead a verified private process group');
  return Object.freeze({ ...id });
}
function validateGroup(child, group) {
  if (process.platform === 'win32' || !group || !Number.isSafeInteger(group.pid) || group.pid <= 0 ||
      group.pid !== child?.pid || group.pid === process.pid || group.pgrp !== group.pid || !group.start || !group.boot)
    throw Error('invalid private fixture process group');
}
function remaining(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) throw Error('fixture group deadline expired; retain its directory');
  return ms;
}
async function bounded(promise, deadline) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('fixture identity observation timed out')), remaining(deadline));
  })]); } finally { clearTimeout(timer); }
}
function ps(args, deadline) {
  const timeout = remaining(deadline);
  return new Promise((resolve, reject) => execFile('/bin/ps', args,
    { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function leader(group, deadline) {
  remaining(deadline);
  if (process.platform === 'linux') {
    const [stat, boot] = await bounded(Promise.all([
      fs.readFile(`/proc/${group.pid}/stat`, 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]), deadline);
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (/^[ZX]$/.test(f[0]) || !f[19]) throw Error('fixture leader is absent; no group signal authorized');
    return { start: f[19], boot: boot.trim(), pgrp: Number(f[2]) };
  }
  const text = (await ps(['-o', 'lstart=,pgid=,stat=', '-p', String(group.pid)], deadline)).trim();
  if (text.length < 26) throw Error('fixture leader observation unavailable');
  const fields = text.slice(24).trim().split(/\s+/);
  if (/^[ZX]/.test(fields[1] || '')) throw Error('fixture leader is absent; no group signal authorized');
  return { start: text.slice(0, 24).trim(), boot: group.boot, pgrp: Number(fields[0]) };
}
async function liveGroup(group, deadline) {
  const text = await ps(['-axo', 'pid=,pgid=,stat='], deadline);
  const rows = text.trim().split('\n').map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) throw Error('unreadable process-group table; retain fixture');
    return { pid: Number(m[1]), group: Number(m[2]), state: m[3] };
  });
  if (!rows.some(row => row.pid === process.pid)) throw Error('process-group table omitted its observer; retain fixture');
  return rows.filter(row => row.group === group.pid && !/^[ZX]/.test(row.state));
}
async function stopOwnedGroup(child, group, deadline) {
  validateGroup(child, group);
  if (!(await liveGroup(group, deadline)).length) return; // no signal, no ownership inference
  if (child.exitCode !== null || child.signalCode !== null)
    throw Error('fixture leader already exited; no group signal authorized');
  const now = await leader(group, deadline);
  if (now.start !== group.start || now.boot !== group.boot || now.pgrp !== group.pid)
    throw Error('fixture process identity changed; retain its directory');
  remaining(deadline); // destructive action cannot start after expiry
  if (child.exitCode !== null || child.signalCode !== null)
    throw Error('fixture leader exited during observation; no group signal authorized');
  try { process.kill(-group.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (;;) {
    const live = await liveGroup(group, deadline);
    if (!live.length) return;
    remaining(deadline);
    await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining(deadline))));
  }
}
module.exports = { captureOwnedGroup, validateGroup, stopOwnedGroup };
