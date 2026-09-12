'use strict';

const { revision } = require('./memory-images');
const { createMultimodalMemory, modelIdentity } = require('./multimodal-memory');
const { runInternalModel } = require('./internal-model');

// The seam between aiconvo's existing `pi` transport and the cold model-only
// worker. Image mode reroutes memory document work only — review, naming and
// other text helpers keep the existing transport untouched.
function createMemoryFeature(hooks) {
  const selected = () => hooks.settings();
  const context = () => hooks.context.getStore();
  const check = () => { context()?.check?.(); };
  async function model(input, prompt, guard = check, options = {}) {
    const authorize = () => { check(); guard(); };
    authorize();
    const message = await (hooks.runInternalModel || runInternalModel)(input, prompt, {
      ...options, settings: selected(), check: authorize, claudeCodeExtension: hooks.claudeCodeExtension?.(),
    });
    authorize();
    hooks.usage?.(message);
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
  const builder = createMultimodalMemory({ parseFile: hooks.parseFile, settings: selected, run: model,
    projectOf: data => hooks.projectOf(data.key), check });
  return {
    model, check,
    // Shared routing seam: callers cannot lose their explicit metadata at the
    // transport switch, and a call that is not memory work is never rerouted.
    routeCall(input, prompt, options = {}) {
      const c = context();
      return {
        modelOnly: !!(selected().memoryImages && (options.memory || c?.memory)),
        invoke: () => model(input, prompt, options.guard, options),
      };
    },
    build: (data, guard) => builder.build(data, hooks.sourceFile(data.key), guard),
    enabled: () => selected().memoryImages,
    // Leaf freshness binds the raw source bytes and the selected internal
    // model, so a model or mode change cannot inherit an old text cache.
    fingerprint: rev => revision('attributed-memory-v1\0' + rev + '\0' + modelIdentity(selected())),
  };
}
module.exports = { createMemoryFeature };
