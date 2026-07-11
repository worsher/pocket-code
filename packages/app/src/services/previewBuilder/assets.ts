// builder 静态资产就位:把 metro asset(哈希名散文件)复制到
// Paths.cache/preview-builder/ 固定名同目录 —— builder.html 相对 fetch
// "./esbuild.wasm" 依赖同目录布局。幂等:已存在则跳过复制。
import { Asset } from "expo-asset";
import { Paths, Directory, File } from "expo-file-system";

export async function ensureBuilderAssets(): Promise<{ htmlUri: string; dirUri: string }> {
  const dir = new Directory(Paths.cache, "preview-builder");
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });

  const html = new File(dir, "builder.html");
  const wasm = new File(dir, "esbuild.wasm");

  if (!html.exists || !wasm.exists) {
    const [htmlAsset, wasmAsset] = await Promise.all([
      Asset.fromModule(require("../../../assets/preview-builder/builder.html")).downloadAsync(),
      Asset.fromModule(require("../../../assets/preview-builder/esbuild.wasm")).downloadAsync(),
    ]);
    if (!htmlAsset.localUri || !wasmAsset.localUri) throw new Error("构建器初始化失败");
    if (!html.exists) new File(htmlAsset.localUri).copy(html);
    if (!wasm.exists) new File(wasmAsset.localUri).copy(wasm);
  }
  return { htmlUri: html.uri, dirUri: dir.uri };
}
