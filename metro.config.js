const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.blockList = [
  /node_modules\/[^/]+\/android\/src\/.*/,
  /node_modules\/@[^/]+\/[^/]+\/android\/src\/.*/,
  /node_modules\/[^/]+\/ios\/.*/,
  /node_modules\/@[^/]+\/[^/]+\/ios\/.*/,
  /node_modules\/.*\/\.git\/.*/,
];

module.exports = config;