const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const defaultBlockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : config.resolver.blockList
  ? [config.resolver.blockList]
  : [];

config.resolver.blockList = [
  ...defaultBlockList,
  /node_modules\/[^/]+\/android\/src\/.*/,
  /node_modules\/@[^/]+\/[^/]+\/android\/src\/.*/,
  /node_modules\/[^/]+\/ios\/.*/,
  /node_modules\/@[^/]+\/[^/]+\/ios\/.*/,
  /node_modules\/.*\/\.git\/.*/,
];

module.exports = config;