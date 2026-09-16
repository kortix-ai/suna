module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo', 'nativewind/babel'],
    plugins: [
      // Deep-import icon barrels (lucide-react-native, @expo/vector-icons) before
      // presets run, so per-icon value imports never reach the un-tree-shaken
      // root barrel. See babel-plugins/deep-icon-imports.js.
      // Metro's transform cache keys on this file, not on files it requires:
      // editing deep-icon-imports.js alone does NOT invalidate the cache. Run
      // `expo start -c` after changing the plugin (not just this config file).
      './babel-plugins/deep-icon-imports',
    ],
  };
};
