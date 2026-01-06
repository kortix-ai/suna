module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo', 'nativewind/babel'],
    plugins: [
      'react-native-worklets/plugin',
      'react-native-reanimated/plugin',
    ],
  };
};
