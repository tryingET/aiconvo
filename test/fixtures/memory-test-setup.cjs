'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAiPrograms } = require('../../ai-programs');
const { createLiveCalls } = require('../../programs-live');
const fixture = require('./memory-fixture.cjs');
function setup(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-full-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ unrelated: { type: 'api_key', key: 'not-a-secret' } }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { unrelated: { apiKey: 'not-a-secret' } } }));
  const file = path.join(root, 'source.jsonl'); fs.writeFileSync(file, fixture.jsonl(fixture.transcript()));
  const settings = { memoryImages: true, provider: 'memory-fixture', model: 'vision', contextTokens: 128000,
    providerExtensions: { 'memory-fixture': [path.resolve(__dirname, 'memory-provider.ts')] } };
  const capture = path.join(root, 'capture.jsonl'), folder = path.join(root, 'calls'), ops = [];
  const live = createLiveCalls({ publish: batch => ops.push(...batch), flushMs: 1 });
  let agentCalls = 0;
  const programs = createAiPrograms({ piExec: async () => { agentCalls++; throw new Error('User agent must not run'); },
    lm: () => 'never/ambient', logFolder: () => folder, live });
  const transport = () => ({ agentDir, env: { MEMORY_FIXTURE_CAPTURE: capture, ...extraEnv }, timeoutMs: 15000 });
  const captures = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const records = () => fs.existsSync(folder) ? fs.readdirSync(folder).flatMap(d => fs.readdirSync(path.join(folder,d)).flatMap(f => fs.readFileSync(path.join(folder,d,f), 'utf8').trim().split('\n').map(JSON.parse))) : [];
  const data = () => ({ key: 'pi:source', title: 'Existing title', messages: [{ role: 'user', eid: 'u0', origin: 'delegation' }] });
  const waitForCapture = async () => {
    for (let i = 0; i < 1500; i++) { if (captures().length) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Fake provider capture deadline exceeded');
  };
  return { root, agentDir, file, settings, capture, programs, transport, captures, records, live, ops, data, waitForCapture, agentCalls: () => agentCalls };
}
module.exports = { setup };
