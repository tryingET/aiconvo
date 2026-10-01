'use strict';
// Read-only test observation of the real server's installed subscribers. No
// guard, payload, model or stream behavior is replaced (used for red and green).
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const original = Module._extensions['.js'];
Module._extensions['.js'] = (module, file) => {
  if (file !== path.resolve('server.js')) return original(module, file);
  module._compile(fs.readFileSync(file, 'utf8') + `
process.on('message', packet => {
  if (packet.operation === 'test-distill-listeners') process.send({ id: packet.id, value: distillJobs.get(packet.key)?.listeners.size || 0 });
});\n`, file);
};
