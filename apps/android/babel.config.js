const {
  expoRouterBabelPlugin,
} = require('babel-preset-expo/build/expo-router-plugin');

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // In this npm-workspaces monorepo, expo-router lives in
    // apps/android/node_modules (not hoisted to the workspace root), so
    // babel-preset-expo's internal `require.resolve('expo-router')` check fails
    // and it silently skips its router plugin. Without that plugin,
    // `process.env.EXPO_ROUTER_APP_ROOT` is never inlined to a string literal
    // and Metro throws "Invalid call ... require.context". Including the plugin
    // explicitly fixes the transform regardless of hoisting. (Idempotent: if
    // the preset also adds it, the second pass is a no-op.)
    plugins: [expoRouterBabelPlugin],
  };
};
