'use strict';
require('./win-hide.js');
// Private cold worker: no AgentSession, tool executor, or ambient resource discovery.
// Explicit extension factories execute trusted code, NOT sandboxed code.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { decodeImage, LIMITS } = require('./memory-images');
let prepared, preparing = false, invoked = false;
const send = packet => new Promise((resolve, reject) => process.send(packet, e => e ? reject(e) : resolve()));
async function prepare(request) {
  const pkg = JSON.parse(fs.readFileSync(path.join(request.packageDir, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== '0.87.1') throw new Error('Memory runtime requires pinned Pi 0.87.1; no fallback');
  const sdk = await import(pathToFileURL(path.join(request.packageDir, 'dist/index.js')).href);
  const loader = new sdk.DefaultResourceLoader({ cwd: process.cwd(), agentDir: request.agentDir,
    settingsManager: sdk.SettingsManager.inMemory({}), additionalExtensionPaths: request.extensions,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new Error('Explicit provider extension failed to load');
  for (const extension of loaded.extensions) if (extension.handlers.size) {
    throw new Error('Model-only memory rejects lifecycle/input/payload hooks');
  }
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(request.agentDir, 'auth.json'),
    modelsPath: path.join(request.agentDir, 'models.json'), modelsStorePath: path.join(request.agentDir, 'models-store.json'),
    allowModelNetwork: false, refreshOnCreate: false, signal: AbortSignal.timeout(request.timeoutMs) });
  for (const { name, config } of loaded.runtime.pendingProviderRegistrations) {
    if (name === request.settings.provider) runtime.registerProvider(name, config);
  }
  for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations) {
    if (provider.id === request.settings.provider) runtime.registerNativeProvider(provider);
  }
  if (runtime.getError()) throw new Error('Invalid selected provider configuration');
  const model = runtime.getModel(request.settings.provider, request.settings.model);
  if (!model || model.provider !== request.settings.provider || model.id !== request.settings.model) throw new Error('Exact memory model unavailable; no fallback');
  const images = request.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'image') : []);
  for (const image of images) decodeImage(image);
  if ((request.settings.memoryImages || images.length) && !model.input?.includes('image')) throw new Error('Memory model does not declare image input');
  const textBytes = Buffer.byteLength(JSON.stringify(request.messages.map(m => ({ ...m,
    content: Array.isArray(m.content) ? m.content.filter(c => c.type !== 'image') : m.content }))));
  const cost = Math.ceil(textBytes / 2) + images.length * LIMITS.imageTokens + 8000;
  if (!Number.isFinite(model.contextWindow) || cost > Math.min(model.contextWindow, request.settings.contextTokens) * 0.8) throw new Error('Memory request exceeds model context admission budget');
  // FunctAI's correction turns carry lm15 text, not Pi assistant metadata.
  // Bind those prior replies to this exact admitted model (never another agent).
  request.messages = request.messages.map(m => m.role !== 'assistant' ? m : { ...m,
    api: model.api, provider: model.provider, model: model.id, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  prepared = { request, model, runtime, loaded };
  await send({ type: 'ready' });
}
async function invoke() {
  if (!prepared || invoked) throw new Error('Duplicate or unprepared memory invocation');
  invoked = true;
  const { request, model, runtime } = prepared;
  const stream = runtime.streamSimple(model, { messages: request.messages }, {
    reasoning: request.settings.thinking === 'off' ? undefined : request.settings.thinking,
    maxTokens: Math.min(8000, model.maxTokens || 8000), maxRetries: 0, timeoutMs: request.timeoutMs, signal: AbortSignal.timeout(request.timeoutMs),
  });
  for await (const e of stream) {
    if (e.type === 'text_delta' || e.type === 'thinking_delta') await send({ type: e.type, text: e.delta });
  }
  const message = await stream.result();
  if (message.role !== 'assistant' || message.provider !== model.provider || message.model !== model.id ||
      message.stopReason !== 'stop' || !Array.isArray(message.content) || message.content.some(c => !['text', 'thinking'].includes(c.type))) {
    throw new Error('Memory provider returned failure, incomplete response, or tools; no continuation');
  }
  await send({ type: 'result', message });
}
if (require.main === module) {
  process.on('message', packet => {
    (async () => {
      if (packet.type === 'prepare' && !preparing) { preparing = true; await prepare(packet); }
      else if (packet.type === 'invoke') await invoke();
      else throw new Error('Invalid memory worker protocol');
    })().catch(async () => { try { await send({ type: 'error', error: 'Memory worker failed (configuration/provider details withheld)' }); } finally { process.exit(1); } });
  });
  process.on('disconnect', () => process.exit(1));
}
