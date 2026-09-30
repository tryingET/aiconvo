'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { setup } = require('./fixtures/memory-test-setup.cjs');
const { createMultimodalMemory } = require('../multimodal-memory');
const { runInternalModel } = require('../internal-model');
const processes = require('../processes');
const fixture = require('./fixtures/memory-fixture.cjs');
const make = s => createMultimodalMemory({ programs: s.programs, settings: () => s.settings, transport: s.transport,
  projectOf: () => 'fixture', check() {} });
test('owned supervisor/process tree removes a provider descendant on completion and abort', async t => {
  for (const abort of [false, true]) {
    const s = setup(t, { MEMORY_FIXTURE_CHILD: '1', ...(abort ? { MEMORY_FIXTURE_WAIT: '30000' } : {}) });
    const ac = new AbortController(); const working = make(s).build(s.data(), s.file, { signal: ac.signal });
    const observed = working.catch(() => null);
    await s.waitForCapture();
    const pid = s.captures()[0].childPid; assert.ok(pid);
    if (abort) { ac.abort(); await assert.rejects(working, e => e.code === 'ABORTED'); } else await working;
    await observed; assert.equal(processes.identity(pid), null);
    assert.equal(fs.existsSync(s.captures()[0].cwd), false);
  }
});
test('static models.json without extension routes through fake loopback provider with exact source bytes and one correction', async t => {
  const s = setup(t), requests = [];
  const server = http.createServer((req,res) => {
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = requests.length === 1 ? 'Malformed first reply' : '<note>Static note.</note><abstract>Static abstract.</abstract><intent>[]</intent><environment>[]</environment><problems>[]</problems>';
      res.end('data: ' + JSON.stringify({ id: 'fake', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n' +
        'data: ' + JSON.stringify({ id: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n' + 'data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  s.settings.provider = 'memory-static'; s.settings.model = 'vision'; s.settings.providerExtensions = {};
  fs.writeFileSync(path.join(s.agentDir, 'models.json'), JSON.stringify({ providers: { 'memory-static': {
    api: 'openai-completions', apiKey: 'synthetic-not-a-credential', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    models: [{ id: 'vision', input: ['text','image'], contextWindow: 128000, maxTokens: 8000, compat: { supportsStore: false } }] } } }));
  const out = await make(s).build(s.data(), s.file); assert.equal(out.leaf.imageCount, 4); assert.equal(requests.length, 2);
  assert.equal(requests[0].body.model, 'vision'); assert.equal(requests[0].body.tools, undefined);
  const images = requests[0].body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'image_url') : []);
  assert.equal(images.length, 4); assert.equal(images[0].image_url.url, 'data:image/png;base64,' + fixture.image().data);
  assert.deepEqual(requests[1].body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'image_url') : []), images);
  assert.equal(s.records()[0].exchanges.length, 2);
  assert.equal(s.records()[0].model, 'memory-static/vision'); assert.equal(s.agentCalls(), 0);
});
test('unpinned Pi package, unsupported request tools, bad image and absent credential directory fail closed', async t => {
  const s = setup(t), request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }], timestamp: 0 }] };
  const pkg = path.join(s.root, 'unpinned'); fs.mkdirSync(pkg); fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.87.2' }));
  const opts = { ...s.transport(), settings: s.settings, check() {} };
  await assert.rejects(runInternalModel(request, { ...opts, packageDir: pkg })); assert.equal(s.captures().length, 0);
  await assert.rejects(runInternalModel(request, { ...opts, agentDir: undefined }), /agentDir/);
  await assert.rejects(runInternalModel({ messages: [{ role: 'system', content: 'x', toolsAdded: [{ name: 'bash' }] }] }, opts), /tools/);
  await assert.rejects(runInternalModel({ messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/gif', data: 'AAAA' }] }] }, opts), /PNG and JPEG/);
});
