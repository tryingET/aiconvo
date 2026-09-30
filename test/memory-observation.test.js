'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { observation, sessionOrigin } = require('../memory-observation');
test('only matching live creation + origin qualifies: restart/import/clock anomalies baseline', () => {
  const snapshot = { text: '{"type":"session","timestamp":"1970-01-01T00:00:00.120Z"}', stat: { birthtimeMs: 110, dev: 1, ino: 2 } };
  const event = { kind: 'watch-create', epoch: 'e', observedAt: 115, birthtimeMs: 110, dev: 1, ino: 2 };
  assert.equal(observation(snapshot, event, 'e', 100, 130).kind, 'live-new');
  for (const changed of [{ ...event, observedAt: 200 }, { ...event, epoch: 'old' }, { ...event, ino: 3 },
    { ...event, birthtimeMs: 111 }, { ...event, kind: 'enumeration' }, undefined]) assert.equal(observation(snapshot, changed, 'e', 100, 130).kind, 'baseline-discovery');
  assert.equal(observation(snapshot, event, 'e', 100, 119).kind, 'baseline-discovery');
  for (const text of ['{"type":"session"}', '{bad', '{"type":"session","timestamp":"2020-01-01"}',
    '{"type":"session","timestamp":"1970-01-01T00:00:00.050Z"}']) assert.equal(observation({ ...snapshot, text }, event, 'e', 100, 130).kind, 'baseline-discovery');
  assert.equal(sessionOrigin('{"type":"user","uuid":"x","timestamp":"2020-01-01T00:00:00Z"}'), Date.parse('2020-01-01T00:00:00Z'));
});
