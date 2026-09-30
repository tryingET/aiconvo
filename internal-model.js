'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createProcessOwner } = require('./memory-process-owner');
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
    let chain = Promise.resolve(), killOK = false, escalation = null, cleanupDeadline = null, deadline = Infinity;
    const owner = createProcessOwner();
    const signalOwned = signal => { if (!owner.signal(signal, deadline)) killOK = false; };
    const stop = error => {
      if (terminal) return;
      terminal = true; failure = error || null;
      if (!child?.pid) return;
      deadline = Date.now() + 4000;
      cleanupDeadline = setTimeout(() => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Memory tree cleanup not established; temporary state retained'), { retainTemporaryState: true }));
      }, 4000);
      try {
        owner.capture(anchor, deadline);
        killOK = true;
        signalOwned('SIGTERM');
        escalation = setTimeout(() => signalOwned('SIGKILL'), 150);
      } catch { killOK = false; failure = new Error('Memory worker cleanup failed'); signalOwned('SIGKILL'); }
    };
    const abort = () => stop(stopped());
    const timer = setTimeout(() => stop(Object.assign(new Error('Memory model deadline exceeded; no replay'), { modelCallFailure: invoked })), timeoutMs);
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'internal-model-supervisor.js'), path.join(__dirname, 'internal-model-worker.js')],
        { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      try { anchor = owner.anchor(child.pid); } catch {}
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
      const alive = () => owner.alive(anchor);
      let clean = false;
      try {
        for (let i = 0; i < 30; i++) {
          if (Date.now() > deadline) break;
          if ([0, 5, 15].includes(i)) signalOwned('SIGKILL');
          if (!alive()) { clean = true; break; }
          await new Promise(r => setTimeout(r, 100));
        }
      } catch {}
      if (child.pid && (!terminal || !killOK || !clean)) {
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
      if (!anchor) stop(new Error('Supervisor identity unavailable'));
      else if (signal?.aborted) abort();
      else if (!terminal) send({ type: 'prepare', ...request });
    }).catch(stop);
  });
}
module.exports = { runInternalModel, DEFAULT_PACKAGE };
