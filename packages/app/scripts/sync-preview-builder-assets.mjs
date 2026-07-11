// postinstall:从 node_modules/esbuild-wasm 生成 preview-builder 静态资产。
// 生成物(builder.html / esbuild.wasm)gitignore —— 避免 11MB 进仓;
// EAS/CI 装依赖时本脚本自动重建。模板 builder-template.html 进 git。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const outDir = join(appRoot, "assets", "preview-builder");
// pnpm hoists node_modules to monorepo root; search up from appRoot
let nodeModulesPath = join(appRoot, "node_modules");
if (!existsSync(join(nodeModulesPath, "esbuild-wasm"))) {
  nodeModulesPath = join(appRoot, "..", "..", "node_modules");
}
const wasmSrc = join(nodeModulesPath, "esbuild-wasm", "esbuild.wasm");
const browserJsSrc = join(nodeModulesPath, "esbuild-wasm", "lib", "browser.js");
const templateSrc = join(outDir, "builder-template.html");

if (!existsSync(wasmSrc) || !existsSync(browserJsSrc)) {
  console.error("[preview-builder] esbuild-wasm 未安装,跳过资产同步");
  process.exit(0); // 不阻断 install(比如 CI 只装部分包)
}
mkdirSync(outDir, { recursive: true });
copyFileSync(wasmSrc, join(outDir, "esbuild.wasm"));

const template = readFileSync(templateSrc, "utf8");
const browserJs = readFileSync(browserJsSrc, "utf8");
if (!template.includes("{{ESBUILD_BROWSER_JS}}")) {
  console.error("[preview-builder] 模板缺 {{ESBUILD_BROWSER_JS}} 占位符");
  process.exit(1);
}
// 用函数形式 replace,防 browser.js 内容中的 $ 序列被当替换模式
writeFileSync(join(outDir, "builder.html"), template.replace("{{ESBUILD_BROWSER_JS}}", () => browserJs));
console.log("[preview-builder] assets synced (builder.html + esbuild.wasm)");
