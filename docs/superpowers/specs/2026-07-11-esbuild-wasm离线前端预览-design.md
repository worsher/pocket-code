# esbuild-wasm 离线前端预览(模式 B/C)· 设计

日期:2026-07-11
状态:已评审(逐节确认通过)
前置:重构设计 §5.3/§6(模式定义正典)、P4 影子快照(模式 B 源码路径)、P11 内核统一 + iOS 平台隔离(iOS remote-only 定位)

## 1. 背景与目标

重构设计定义的三模式中,A(配对开发机)已是主力;B(前端·边改边看)与 C(纯端侧)
共同缺一块:**端侧构建 + 本地渲染层**。两条源码路径均已存在 ——
模式 B:`workspaceSync.syncRemoteToLocal`(P4)把开发机源码拉到手机工作区;
模式 C:`gitService` 的 `git.clone` + 本地 agent 改文件。
缺的只是:手机本地目录 → 打包 → 手机上看。

**目标**:PreviewTab 触发,WebView 内 esbuild-wasm 把手机工作区的前端项目打包,
产物落盘 `dist/`,PreviewTab 以 `file://` 加载渲染。离线可用(依赖已缓存时)。

**iOS 特殊价值**:iOS 为 remote-only(沙箱禁 fork/exec),本功能是其唯一合法的
"本地能力"路径 —— WASM 跑在 WebView(真浏览器)内,不 fork 进程。
Android 同样受益(离线场景)。两平台同发,不做平台分叉。

## 2. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| D1 | npm 依赖从哪来 | CDN(esm.sh)加载 + expo-fs 本地缓存;首次联网预热,缓存命中后真离线。能预览真实 React/Vue(非 SFC)项目 |
| D2 | 渲染架构 | 构建落盘 dist → PreviewTab `file://` 加载。产物持久(重进 App 免重建)、构建/渲染解耦;「开发机 build→同步 dist→手机静态预览」低成本变体共享同一渲染路 |
| D3 | 项目入口约定 | Vite 惯例:项目根 `index.html` 为入口,解析 `<script type="module" src=...>` 取 JS 入口;无 index.html 报清晰错误(agent 场景下让 agent 补一个即可) |
| D4 | UI 入口 | PreviewTab 内加「本地构建」按钮;v1 手动触发,文件变化自动重建留 follow-up |
| D5 | 逻辑分布(架构核心) | **纯逻辑在 RN 侧,WebView 是哑执行器**:esbuild `onResolve`/`onLoad` 全部经 bridge 回 RN 决策;WebView 内联脚本退化为极薄执行器(初始化 esbuild-wasm、bridge 收发、调 build)。纯逻辑全部 vitest 可测;构建低频,bridge 往返成本可接受 |
| D6 | 构建对象 | 当前项目工作区(`getProjectWorkspaceRoot(projectId)`,无项目则默认工作区)—— 沿用 FilesTab 既有语义 |

## 3. 组件与边界(全部在 packages/app)

| 组件 | 位置 | 职责 |
|---|---|---|
| `previewBuilder/` 服务 | `src/services/previewBuilder/`(新目录,多个纯 TS 模块) | 入口解析(index.html→JS 入口与 html 改写)、resolve 决策(相对/绝对路径→工作区 fs;裸引用→esm.sh URL,版本读 package.json)、CDN 缓存(expo-fs,URL 为 key)、bridge 协议编解码、dist 写盘 |
| builder WebView | PreviewTab 内隐藏挂载(仅构建期间) | 加载 `builder.html` asset,初始化 esbuild-wasm,`onResolve`/`onLoad` 转发 bridge,产物回传 |
| `builder.html` + `esbuild.wasm` | App assets(生成物) | 静态资源;wasm ~11MB 打进 App 包;esbuild 的 JS 侧(`esbuild-wasm/lib/browser.js`)**内联进 builder.html**(metro `assetExts` 收不了 `.js`,file:// 改名加载有 MIME 风险)—— builder 自身必须离线可用,不走 CDN |
| PreviewTab 改造 | `src/components/PreviewTab/index.tsx` | 「本地构建」按钮 + 构建状态/错误区;成功后 `source` 切 `file://<workspace>/dist/index.html`;file:// 平台 props |

## 4. 数据流(构建时序)

```
PreviewTab ──① 挂载 builder WebView(file://builder.html)
builder    ──② esbuild-wasm 初始化(fetch 同目录 esbuild.wasm)──ready──►
RN         ──③ 解析入口:读 index.html,取 <script type="module" src> ──start──►
builder    ──④ esbuild.build({entry, plugins:[bridgePlugin]})
           ──⑤ bridgePlugin.onResolve/onLoad → postMessage 逐条问 RN:
RN 侧决策:      相对/绝对路径 → readLocalFile(工作区)
                裸引用(react) → 工作区根 package.json 查版本 → esm.sh/react@<ver> URL
                http(s) URL → 查 expo-fs 缓存:
                  命中 → 直接回内容(真离线)
                  未中 → 指示 builder 在 WebView 内 fetch → 内容回传 RN 落缓存 → 再喂 esbuild
builder    ──⑥ 产物(js/css/assets + 改写后 index.html)→ dist 消息逐文件回 RN
RN         ──⑦ 写 <workspace>/dist/ → 卸载 builder WebView
PreviewTab ──⑧ source 切 file://<workspace>/dist/index.html
```

**bridge 协议**:单一 JSON 信封,`{id, type, ...}` 请求 / `{id, ok, ...}` 响应,
经 `postMessage`/`onMessage`:
- builder→RN:`ready` / `resolve{path, importer}` / `load{path}` /
  `fetched{url, content}`(CDN 回存)/ `dist{path, content}` / `done{warnings}` /
  `error{message, location}`
- RN→builder:`start{entryJs, entryHtml}` / `resolved{path 或 external-url}` /
  `loaded{contents, loader}` / `fetch{url}`(指示去拉);二进制内容 base64 编码

**esm.sh 递归依赖**:esm.sh 返回的模块内部还有 `https://esm.sh/...` 子 import,
同走 ⑤ 的 http 分支(缓存/回存),递归收敛。缓存 key = 完整 URL,
存 `Paths.cache/preview-deps/<sha1(url)>`。

## 5. 错误处理(全部显示在 PreviewTab 构建状态区)

| 场景 | 行为 |
|---|---|
| 无 index.html / html 无 module script | 「入口缺失:需要 index.html + `<script type="module" src=...>`」 |
| esbuild 编译错误 | 透传 esbuild message + file:line |
| 裸引用未缓存且离线 | 「依赖 <名> 未缓存,首次构建需联网」 |
| WebView/wasm 初始化失败(超时 15s) | 「构建器初始化失败」+ 卸载 |
| dist 写盘失败 | expo-fs 错误透传 |
| 取消 | 再点按钮/离开 Tab → 卸载 builder WebView 即终止 |

## 6. 平台与工程约束

- **wasm 必须在 WebView 跑**(重构设计 §5.3 既定):Hermes 不支持 WASM;
  WKWebView(iOS)与 Android WebView(Chrome 57+)均支持。
- **assets 进包**:需新建 `metro.config.js`(现无)加 `assetExts` 扩展 `wasm`/`html`;
  运行时 `expo-asset` 取 `localUri`。**App 体积 +≈11MB**。
- **esbuild-wasm pin 版本**:npm devDependency;**postinstall 同步脚本**从
  `node_modules/esbuild-wasm` 生成 assets —— 复制 `esbuild.wasm`、把 `lib/browser.js`
  内联进手写模板 `builder-template.html` 产出 `builder.html`。模板提交 git,
  两个生成物 gitignore(避免 11MB 进仓;EAS/CI 装依赖时 postinstall 自动重建)。
- **file:// 平台 props**:Android `allowFileAccess` + `allowFileAccessFromFileURLs`;
  iOS `allowingReadAccessToURL` 指向**工作区根**(dist 及其相对资源都在其下);
  builder WebView 同理指向 assets 目录。
- **Expo Go 可验**:无新原生模块(WebView/expo-asset/expo-fs 均内置)——
  iOS 不出包即可真机验。
- 既有远程预览(URL/隧道)行为零变化。

## 7. 测试策略

- `previewBuilder/` 纯模块 vitest 单测:
  - 入口 html 解析/改写:无 script、多 script、相对 src 各形态;
  - 裸引用→esm.sh URL:package.json 有/无版本、scoped 包 `@x/y`、子路径 `react-dom/client`;
  - 缓存 key 与命中判定;
  - bridge 协议编解码(含非法消息拒收)。
- builder.html 内联脚本:薄执行器,不单测,端到端人工验收兜底。
- PreviewTab:构建状态机(idle→building→success/error)可提纯则单测;UI 人工验收。
- **人工验收案例**:含 react 依赖的最小 Vite 项目 → 首次联网构建成功并渲染 →
  开飞行模式 → 再次构建(全缓存命中)成功 → 重进 App 直接看 dist 不重建。

## 8. 验收标准

- `pnpm test:all` 全绿;previewBuilder 单测覆盖 §7 用例。
- Android + iOS(Expo Go)人工验收案例通过。
- 既有远程预览行为零变化。

## 9. 范围外

文件变化自动重建 / HMR、`.vue` SFC、sourcemap、多入口、dist 清理策略、
「开发机 build→同步 dist」变体的专门 UI(渲染层已兼容,入口后置)、
esbuild 之外的构建器、agent 工具触发构建(后续增强)。
