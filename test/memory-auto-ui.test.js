'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeSettings } = require('../settings');
const policy = require('../policy');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
test('legacy default, opted policies and malformed settings normalization', () => {
  assert.equal(normalizeSettings({}).automaticMemory, 'legacy');
  for (const mode of ['legacy', 'off', 'changes-after-enable']) assert.equal(normalizeSettings({ automaticMemory: mode }).automaticMemory, mode);
  assert.equal(normalizeSettings({ automaticMemory: 'typo' }).automaticMemory, 'off');
});
test('settings UI explains scope, no backfill, old context and failures; unsafe state text is escaped', () => {
  const settings = normalizeSettings({ automaticMemory: 'changes-after-enable' });
  const context = { settingsOf: () => settings, settingsState: { canEditSettings: true, automaticMemory: { error: '<script>', pending: [{ key: '<private>', status: 'error', error: '<failure>' }] } },
    esc: s => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
  vm.createContext(context);
  const begin = html.indexOf('function backgroundAiSectionHtml()'), end = html.indexOf('\nfunction bindPaneModel(', begin);
  vm.runInContext(html.slice(begin, end), context);
  const output = context.backgroundAiSectionHtml();
  assert.match(output, /value="changes-after-enable" selected/);
  assert.match(output, /old context/); assert.match(output, /not backfilled/); assert.match(output, /never retry automatically/);
  assert.match(output, /&lt;script&gt;/); assert.match(output, /&lt;private&gt;/); assert.doesNotMatch(output, /<script>/);
  context.settingsState.canEditSettings = false;
  assert.match(context.backgroundAiSectionHtml(), /id="setAutomaticMemory" disabled/);
  assert.doesNotMatch(context.backgroundAiSectionHtml(), /class="setMemoryDiscard"/);
});
test('policy change and explicit discard stay on the existing owner permission surface', () => {
  const owner = { tier: 'owner', user: { id: 'o', role: 'owner' } }, member = { tier: 'member', user: { id: 'm', role: 'member' } };
  for (const route of ['/api/settings/background-ai', '/api/settings/memory-discard']) {
    assert.equal(policy.routeEntry('POST', route).level, 'owner');
    assert.equal(policy.checkRoute(owner, 'POST', route, new URLSearchParams(), () => true).ok, true);
    assert.equal(policy.checkRoute(member, 'POST', route, new URLSearchParams(), () => true).ok, false);
  }
});
test('all inline browser scripts parse after scope UI additions', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (match[1].trim()) new vm.Script(match[1]);
});
