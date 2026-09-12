// NOTE: babel-preset-expo keeps the router plugin at
// `babel-preset-expo/build/plugins/expo-router-plugin` (not `build/expo-router-plugin`).
// Resolve it lazily and tolerate absence: the preset already adds the plugin
// automatically when expo-router is installed, so a missing explicit require
// must never crash Metro's transformer construction (which surfaces only as
// the cryptic `Cannot read properties of undefined (reading 'transformFile')`).
function getExpoRouterPlugin() {
  try {
    const { expoRouterBabelPlugin } = require('babel-preset-expo/build/plugins/expo-router-plugin');
    return typeof expoRouterBabelPlugin === 'function' ? expoRouterBabelPlugin : null;
  } catch {
    return null;
  }
}

module.exports = function (api) {
  api.cache(true);
  // In this npm-workspaces monorepo, expo-router lives in
  // apps/android/node_modules (not hoisted to the workspace root), so
  // babel-preset-expo's internal `require.resolve('expo-router')` check can fail
  // and it silently skips its router plugin. Without that plugin,
  // `process.env.EXPO_ROUTER_APP_ROOT` is never inlined to a string literal
  // and Metro throws "Invalid call ... require.context". Including the plugin
  // explicitly fixes the transform regardless of hoisting. (Idempotent: if
  // the preset also adds it, the second pass is a no-op.)
  const routerPlugin = getExpoRouterPlugin();
  return {
    presets: ['babel-preset-expo'],
    plugins: routerPlugin ? [routerPlugin] : [],
  };
};
