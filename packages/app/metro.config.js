// metro 配置:让 .wasm/.html 可被 require 为 asset(preview-builder 静态资产)。
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, "wasm", "html"];

module.exports = config;
