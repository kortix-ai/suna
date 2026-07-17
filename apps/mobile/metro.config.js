const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

// Project root and monorepo root
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(__dirname);

// Configure SVG transformer
config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve('react-native-svg-transformer'),
};

// Force Metro to resolve React from mobile app's node_modules to avoid multiple instances
const mobileNodeModules = path.resolve(projectRoot, 'node_modules');

// Modules that should always resolve from mobile's node_modules
// This prevents duplicate React instances when bundling shared packages
const forcedModules = ['react', 'react-native', 'react/jsx-runtime', 'react/jsx-dev-runtime'];

// Node.js built-ins that leak into the bundle graph via third-party packages
// but have no React Native equivalent and are never exercised at runtime.
// `readline` is pulled in by expensify-common's CLI helper (referenced through
// @expensify/react-native-live-markdown). Metro cannot resolve it, so we stub
// it to an empty module. Without this the EAS "Bundle JavaScript" phase fails
// with "Unable to resolve module readline".
const emptyModulePath = path.resolve(projectRoot, 'metro-empty-module.js');
const stubbedNodeBuiltins = new Set(['readline']);

config.resolver = {
  ...config.resolver,
  assetExts: config.resolver.assetExts.filter((ext) => ext !== 'svg'),
  sourceExts: [...config.resolver.sourceExts, 'svg'],
  // Watch additional paths in monorepo
  nodeModulesPaths: [mobileNodeModules, path.resolve(monorepoRoot, 'node_modules')],
  // Ensure packages/shared code is included
  watchFolders: [path.resolve(monorepoRoot, 'packages/shared')],
  // Force resolve React and react-native from mobile's node_modules
  extraNodeModules: {
    react: path.resolve(mobileNodeModules, 'react'),
    'react-native': path.resolve(mobileNodeModules, 'react-native'),
    '@kortix/shared': path.resolve(monorepoRoot, 'packages/shared'),
    '@kortix/sdk': path.resolve(monorepoRoot, 'packages/sdk'),
  },
  // Custom resolver to force React resolution from mobile's node_modules
  // This is critical for monorepo setups where shared packages use React hooks
  resolveRequest: (context, moduleName, platform) => {
    // Stub Node.js built-ins that have no React Native equivalent.
    if (stubbedNodeBuiltins.has(moduleName)) {
      return {
        filePath: emptyModulePath,
        type: 'sourceFile',
      };
    }
    // Check if this module should be forced to resolve from mobile's node_modules
    if (forcedModules.includes(moduleName)) {
      return {
        filePath: require.resolve(moduleName, { paths: [mobileNodeModules] }),
        type: 'sourceFile',
      };
    }
    // Deterministic mapping for the SDK turns subpath — does not depend on
    // Metro's package-exports support. Points at the SDK's `./turns` export
    // target (a framework-free re-export of `core/turns`). The v2 SDK moved
    // the old `src/turns/index.ts` here; keep this in sync with the `exports`
    // map in packages/sdk/package.json.
    if (moduleName === '@kortix/sdk/turns') {
      return {
        filePath: path.resolve(monorepoRoot, 'packages/sdk/src/deprecated/turns.ts'),
        type: 'sourceFile',
      };
    }
    // Fall back to default resolution
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = withNativeWind(config, { input: './global.css', inlineRem: 16 });
