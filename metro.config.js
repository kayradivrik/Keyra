const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  crypto: require.resolve('crypto-browserify'),
  stream: require.resolve('stream-browserify'),
  buffer: require.resolve('buffer/'),
  events: require.resolve('events/'),
  util: require.resolve('util/'),
  process: require.resolve('process/'),
  string_decoder: require.resolve('string_decoder/'),
  vm: require.resolve('vm-browserify'),
};

module.exports = config;

