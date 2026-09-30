'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const processes = require('./processes');
const { memoryConfig } = require('./memory-config');
const { decodeImage, LIMITS } = require('./memory-images');
const DEFAULT_PACKAGE = path.join(__dirname, 'runtime/node_modules/@earendil-works/pi-coding-agent');
const stopped = () => Object.assign(new Error('Memory model call aborted'), { code: 'ABORTED' });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function selectedFile(agentDir, name, provider) {
  const file = path.join(agentDir, name);
  let bytes;
  try { if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('Provider configuration exceeds budget'); bytes = await fs.readFile(file); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return name === 'models.json' ? { providers: {} } : {}; }
  let raw;
  try { raw = JSON.parse(bytes); } catch { throw new Error('Invalid selected provider configuration'); }
  const entries = name === 'models.json' ? raw?.providers : raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (entries != null && (typeof entries !== 'object' || Array.isArray(entries)))) throw new Error('Invalid provider configuration');
  const selected = entries && Object.hasOwn(entries, provider) ? { [provider]: entries[provider] } : {};
  // Commands can reach ambient credentials/resources. Require explicit literals
  // or explicitly supplied env values instead in this cold transport.
  const noCommands = value => {
    if (typeof value === 'string' && value.startsWith('!')) throw new Error('Credential/config commands are unsupported in cold memory transport');
    if (value && typeof value === 'object') Object.values(value).forEach(noCommands);
  };
  noCommands(selected);
  return name === 'models.json' ? { providers: selected } : selected;
}

/** Called only by pirouter for an opted memory program. `check` is the current
 * bound permission + revision guard, not a parallel yes/no consent store. */
async function runInternalModel(request, options = {}) {
  if (typeof options.check !== 'function') throw new Error('A live bound memory permission guard is required');
  const permission = () => { const result = options.check(); if (result === false || result?.then) throw new Error('Bound memory permission denied or asynchronous guard unsupported'); };
  permission();
  if (options.signal?.aborted) throw stopped();
  const settings = memoryConfig(options.settings);
  if (!path.isAbsolute(options.agentDir || '')) throw new Error('Explicit credential agentDir required; no ambient lookup');
  if (!Array.isArray(request.messages) || !request.messages.length) throw new Error('Invalid memory messages');
  const images = request.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'image') : []);
  if (images.length > LIMITS.callImages) throw new Error('Memory call image count exceeds budget');
  for (const image of images) decodeImage(image);
  for (const m of request.messages) {
    if (!['system', 'user', 'assistant'].includes(m.role) || (Array.isArray(m.content) && m.content.some(c => !['text', 'image', 'thinking'].includes(c.type)))) throw new Error('Unsupported memory content');
    if (m.role === 'system' && (m.toolsAdded?.length || m.toolsRemoved?.length)) throw new Error('Memory cannot declare tools');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chattering-model-'));
  let retain = false;
  try {
    await fs.chmod(root, 0o700);
    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir, { mode: 0o700 });
    for (const name of ['models.json', 'auth.json']) await fs.writeFile(path.join(agentDir, name),
      JSON.stringify(await selectedFile(options.agentDir, name, settings.provider)), { mode: 0o600 });
    const extensions = [], stamps = [];
    for (const file of settings.providerExtensions[settings.provider]) {
      const entry = await fs.realpath(file);
      if (!(await fs.stat(entry)).isFile()) throw new Error('Provider extension must be a regular entrypoint');
      if (!extensions.includes(entry)) { extensions.push(entry); stamps.push([entry, digest(await fs.readFile(entry))]); }
    }
    const check = async () => {
      permission();
      for (const [file, hash] of stamps) if (digest(await fs.readFile(file)) !== hash) throw new Error('Provider extension changed during memory call');
      if (options.signal?.aborted) throw stopped();
    };
    await check();
    // Nothing from the parent's credential, cloud, Node, Pi, or proxy environment
    // is inherited. Provider env is an explicit integration input.
    const env = { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, windir: process.env.windir } : {}), ...(options.env || {}) };
    for (const key of Object.keys(env)) if (/^(PI_|NODE_|FUNCTAI_)/.test(key)) delete env[key];
    Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'config'), LOCALAPPDATA: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
      TMPDIR: root, TMP: root, TEMP: root, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir,
      PI_OFFLINE: '1', JITI_FS_CACHE: 'false', AWS_EC2_METADATA_DISABLED: 'true' });
    const result = await workerOnce({ request: { messages: request.messages, settings, extensions,
      packageDir: options.packageDir || DEFAULT_PACKAGE, agentDir, timeoutMs: options.timeoutMs || 120000 },
      cwd: root, env, check, signal: options.signal, timeoutMs: options.timeoutMs || 120000,
      onDelta: request.onDelta, onThinking: request.onThinking });
    await check();
    return result;
  } catch (e) { retain = !!e.retainTemporaryState; if (retain) e.temporaryDirectory = root; throw e; }
  finally { if (!retain) await fs.rm(root, { recursive: true, force: true }); }
}

function workerOnce({ request, cwd, env, check, signal, timeoutMs, onDelta, onThinking }) {
  return new Promise((resolve, reject) => {
    let child, anchor = null, result = null, failure = null, terminal = false, invoked = false, size = 0;
    let chain = Promise.resolve(), owned = [], killOK = false, escalation = null, cleanupDeadline = null;
    const same = (a, b) => a && b && a.pid === b.pid && a.start === b.start && a.boot === b.boot;
    // Signal only identities proven to descend from this live supervisor. In
    // particular, a detached provider child is owned but has a different PGID.
    const signalOwned = signal => {
      for (const id of owned) {
        try {
          const current = processes.identity(id.pid);
          if (!same(current, id)) continue; // exited or reused: never signal the replacement
          try { process.kill(id.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        } catch { killOK = false; }
      }
    };
    const stop = error => {
      if (terminal) return;
      terminal = true; failure = error || null;
      if (!child?.pid) return;
      cleanupDeadline = setTimeout(() => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Memory tree cleanup not established; temporary state retained'), { retainTemporaryState: true }));
      }, 4000);
      try {
        const table = processes.list();
        if (process.platform === 'linux') {
          if (!same(processes.identity(child.pid), anchor) || !table.some(p => p.pid === child.pid)) throw new Error('Live supervisor ownership unavailable');
          const parents = new Map([[child.pid, anchor]]);
          // Bind the current parent chain, not just stale PIDs in a process-table
          // snapshot. Capture parents first; signal their children first.
          for (const pid of processes.descendantsOf(table, child.pid).reverse()) {
            if (pid === child.pid) continue;
            const id = processes.identity(pid);
            if (!id) continue;
            let fields;
            try { const stat = fsSync.readFileSync('/proc/' + pid + '/stat', 'utf8'); fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); }
            catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) continue; throw e; }
            const ppid = table.find(p => p.pid === pid)?.ppid, parent = parents.get(ppid);
            if (fields[19] !== id.start || Number(fields[1]) !== ppid || !same(processes.identity(ppid), parent)) throw new Error('Descendant ownership changed during capture');
            parents.set(pid, id); owned.unshift(id);
          }
          killOK = true;
          signalOwned('SIGTERM');
          escalation = setTimeout(() => signalOwned('SIGKILL'), 150);
        } else {
          owned = processes.descendantsOf(table, child.pid).map(pid => processes.identity(pid)).filter(Boolean);
          killOK = processes.stopTree(child.pid, 'SIGKILL');
        }
      } catch { killOK = false; failure = new Error('Memory worker cleanup failed'); if (process.platform === 'linux') signalOwned('SIGKILL'); }
    };
    const abort = () => stop(stopped());
    const timer = setTimeout(() => stop(Object.assign(new Error('Memory model deadline exceeded; no replay'), { modelCallFailure: invoked })), timeoutMs);
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'internal-model-supervisor.js'), path.join(__dirname, 'internal-model-worker.js')],
        { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      if (process.platform === 'linux') { try { anchor = processes.identity(child.pid); } catch {} if (anchor) owned.push(anchor); }
    } catch (e) { clearTimeout(timer); reject(e); return; }
    const send = packet => { if (child.connected) child.send(packet, e => { if (e) stop(e); }); else stop(new Error('Memory IPC disconnected')); };
    child.on('message', packet => {
      // Serialize async guards: ready cannot overtake prepare or a revocation.
      chain = chain.then(async () => {
        if (terminal) return;
        size += Buffer.byteLength(JSON.stringify(packet));
        if (size > 64 * 1024 * 1024) throw new Error('Memory output exceeds budget');
        await check();
        if (packet.type === 'ready' && !invoked) { invoked = true; send({ type: 'invoke' }); }
        else if (packet.type === 'text_delta' && invoked) { onDelta?.(packet.text); }
        else if (packet.type === 'thinking_delta' && invoked) { onThinking?.(packet.text); }
        else if (packet.type === 'result' && invoked) { result = packet.message; stop(); }
        else if (packet.type === 'error') stop(Object.assign(new Error(packet.error), { modelCallFailure: invoked }));
        else throw new Error('Invalid memory IPC protocol');
      }).catch(stop);
    });
    child.once('error', stop);
    child.once('close', async () => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      await chain;
      // Unix: group remains identifiable after the anchor exits. Windows:
      // taskkill /T is the platform primitive; check captured identities too.
      const alive = () => {
        const capturedAlive = owned.some(id => same(processes.identity(id.pid), id));
        if (process.platform !== 'win32' && child.pid) {
          return capturedAlive || processes.list().some(p => processes.identity(p.pid)?.pgrp === child.pid);
        }
        return capturedAlive;
      };
      let clean = false;
      try {
        for (let i = 0; i < 30; i++) {
          if (process.platform === 'linux' && [0, 5, 15].includes(i)) signalOwned('SIGKILL');
          if (!alive()) { clean = true; break; }
          await new Promise(r => setTimeout(r, 100));
        }
      } catch {}
      if (child.pid && (!terminal || !killOK || !processes.reliable || !clean)) {
        failure = Object.assign(new Error('Memory tree cleanup not established; temporary state retained'), { retainTemporaryState: true });
      }
      clearTimeout(cleanupDeadline);
      if (failure) reject(failure);
      else if (!result) reject(new Error('Memory worker exited without a result'));
      else resolve(result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    chain = chain.then(async () => {
      await check();
      if (process.platform === 'linux' && !anchor) stop(new Error('Supervisor identity unavailable'));
      else if (signal?.aborted) abort();
      else if (!terminal) send({ type: 'prepare', ...request });
    }).catch(stop);
  });
}
module.exports = { runInternalModel, DEFAULT_PACKAGE };
