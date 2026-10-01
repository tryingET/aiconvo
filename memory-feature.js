'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMultimodalMemory } = require('./multimodal-memory');
const { modelIdentity } = require('./memory-config');
const { revision } = require('./memory-identity');

// Parent retains the current consent, principal, budget and publication authority.
// No scheduler, activation state or second consent store.
function createMemoryFeature(hooks) {
  if (typeof hooks.authorize !== 'function') throw new Error('Current bound parent permission guard required');
  return {
    fingerprint: source => revision('attributed-functai-memory-v1\0' + source + '\0' + modelIdentity(hooks.settings())),
    build(data, options = {}) {
      const bound = AsyncLocalStorage.snapshot();
      const check = () => bound(() => {
        const result = hooks.authorize({ key: data.key, automatic: options.caller?.automatic === true });
        if (result === false || result?.then) throw new Error('Bound permission denied or asynchronous guard unsupported');
      });
      const builder = createMultimodalMemory({ programs: hooks.programs, settings: hooks.settings,
        transport: hooks.transport, projectOf: () => hooks.projectOf(data.key), check });
      return builder.build(data, hooks.sourceFile(data.key), options).then(built => {
        const guard = built.guard;
        return { ...built, guard: () => bound(guard) };
      });
    },
  };
}
module.exports = { createMemoryFeature };
