// Monorepo Metro config: apps/android is an npm workspace, so shared deps
// (expo, react-native, …) are hoisted to the repo root. Without watchFolders
// + nodeModulesPaths, Metro can't resolve them and router transforms break.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Keep Expo's default watchFolders and add the workspace root (don't replace:
// expo-doctor flags missing defaults, and replacing breaks Expo file watching).
config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
