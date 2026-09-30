'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { boot, sanitizeFixtureLog } = require('./worker-server-fixture.cjs');

test('fixture diagnostics redact credentials and pairing/provider links', () => {
  const text = sanitizeFixtureLog('Bearer opaque-bearer apiKey="opaque-key" token=opaque-token https://fixture/pair?token=value chattering://pair/value local-integration-synthetic-token', ['opaque-bearer']);
  assert.doesNotMatch(text, /opaque|fixture\/pair|pair\/value|local-integration-synthetic/);
  assert.match(text, /redacted/);
});

test('unexpected fixture exit reports route, exit status and redacted stderr; readiness rejects', { timeout: 20000 }, async t => {
  let output = ''; const original = process.stderr.write;
  process.stderr.write = function (chunk, ...args) { output += String(chunk); return true; };
  try {
    await assert.rejects(boot(t, { setup({ root, env }) {
      const preload = path.join(root, 'fixture-exit.cjs');
      fs.writeFileSync(preload, 'process.stderr.write("Fixture diagnostic marker Bearer opaque-bearer chattering://pair/synthetic-value\\n"); process.exit(23);');
      env.NODE_OPTIONS = '--require=' + preload;
    } }), /Server exited before scan/);
  } finally { process.stderr.write = original; }
  const records = output.trim().split('\n').filter(line => line.startsWith('[worker fixture] ')).map(line => JSON.parse(line.slice('[worker fixture] '.length)));
  assert.ok(records.some(r => r.exitCode === 23 && r.label === 'unexpected server exit'));
  assert.ok(records.some(r => r.requests.some(q => q.route === '/api/sessions')));
  assert.match(output, /Fixture diagnostic marker/);
  assert.doesNotMatch(output, /opaque-bearer|chattering:\/\/|pair\/synthetic/);
});
