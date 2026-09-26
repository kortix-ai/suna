// babel-preset-expo runs @babel/plugin-transform-flow-strip-types on every
// file, .ts included, before its own TypeScript pass. Flow-strip-types throws
// on a TypeScript `declare` class field (packages/sdk uses them, e.g.
// core/http/api/errors.ts). Our own TypeScript pass runs first (user plugins
// run before preset plugins) and removes `declare` fields, so the Flow pass
// never sees them.
const typescriptPlugin = require.resolve('@babel/plugin-transform-typescript', {
  paths: [require.resolve('babel-preset-expo')],
});

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo', 'nativewind/babel'],
    overrides: [
      {
        test: (fileName) => !!fileName && fileName.endsWith('.ts'),
        plugins: [[typescriptPlugin, { isTSX: false, allowNamespaces: true, allowDeclareFields: true }]],
      },
      {
        test: (fileName) => !!fileName && fileName.endsWith('.tsx'),
        plugins: [[typescriptPlugin, { isTSX: true, allowNamespaces: true, allowDeclareFields: true }]],
      },
    ],
  };
};
