'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Given a passing diagnostic, When TRACE is enabled, Then observations survive the real runner while ordinary success stays quiet', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'diagnostic.test.js');
  fs.writeFileSync(file, "require('node:test')('synthetic observation', () => console.log('NATIVE-OBSERVATION fixture-only'));\n");
  const runner = path.join(__dirname, '..', 'scripts', 'test-each.js');
  for (const trace of ['0', '1']) {
    const env = { ...process.env, CHATTERING_TEST_TRACE: trace };
    // This is a separate CLI invocation, not a child of node:test's IPC runner.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, file], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /1 tests passed.*0 failed/);
    if (trace === '1') assert.match(result.stdout, /NATIVE-OBSERVATION fixture-only/, 'successful native evidence cannot disappear');
    else assert.doesNotMatch(result.stdout, /NATIVE-OBSERVATION fixture-only/, 'normal passing output remains concise');
  }
});
