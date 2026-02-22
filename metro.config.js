// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Stub native-only modules when accidentally bundled for web
const NATIVE_ONLY_MODULES = [
  'react-native/Libraries/Utilities/codegenNativeCommands',
  'react-native/Libraries/Utilities/codegenNativeComponent',
];

const originalResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && NATIVE_ONLY_MODULES.some((m) => moduleName.includes(m))) {
    return { type: 'empty' };
  }
  if (originalResolver) {
    return originalResolver(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
