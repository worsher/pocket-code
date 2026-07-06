# DeepSeek V4 模型升级 设计

> 日期：2026-07-06
> 状态：已与用户确认（命名勘误已认可：家族只有 Pro/Flash 两成员，无基础版 V4、无 "Light"）
> 一句话定位：**App 模型列表 DeepSeek V3 → V4 Pro + V4 Flash 两条目；默认模型与 auto 路由随迁；旧 key 服务端保留兼容。**

## 依据（2026-07-06 查证）

- SiliconFlow 模型 ID：`deepseek-ai/DeepSeek-V4-Pro`（旗舰 1.6T MoE / 1M 上下文）、`deepseek-ai/DeepSeek-V4-Flash`（284B/13B 激活，轻量快速）。
- 官方 DeepSeek API 亦只暴露 pro/flash 两个 V4 型号；用户口中的 "v4 light" = Flash。

## 改动清单

| 位置 | 改动 |
|---|---|
| `app/src/services/modelConfig.ts` | `deepseek-v3` 条目替换为 `deepseek-v4-pro`（label "DeepSeek V4 Pro"，desc "旗舰推理/编码，1M 上下文"）与 `deepseek-v4-flash`（label "DeepSeek V4 Flash"，desc "轻量快速，日常编码性价比"）；`deepseek-r1` 保留；fallback 注释同步 |
| `app/src/services/modelConfig.ts` `getModelConfig` fallback | `deepseek-v3` → `deepseek-v4-flash` |
| `app/src/hooks/useAgent.ts:68` 默认 model | `"deepseek-v3"` → `"deepseek-v4-flash"` |
| `server/src/agent.ts` MODEL_MAP | 新增 `deepseek-v4-pro` / `deepseek-v4-flash` 两条；**保留** `deepseek-v3`/`deepseek-r1` 映射（旧会话历史里的 modelKey 兼容，不出现在 App 列表即可）；`:69` fallback 与 `:143` createSession 默认 → `deepseek-v4-flash`；头注释同步 |
| `server/src/modelRouter.ts` | simple/medium 规则 `deepseek-v3` → `deepseek-v4-flash`；reasoning 保持 `deepseek-r1`；`:130` fallback → `deepseek-v4-flash` |
| `server/src/modelRouter.test.ts` | 对应断言 `deepseek-v3` → `deepseek-v4-flash`（两处） |
| `app/src/store/settings.ts` | 初始 `defaultModel` → `deepseek-v4-flash`（已有安装的持久化旧值经服务端保留映射 + app fallback 双兜底,无需迁移） |
| `app/src/services/workspaceSync.ts` | 两处 `defaultModel` 回退 → `deepseek-v4-flash` |
| `server/src/db.ts` | sessions 建表 `model_key` DEFAULT → `deepseek-v4-flash`（仅影响新建表） |

## 不做

- 删除 deepseek-r1（未被要求）；官方 API base 切换（继续走 SiliconFlow）；think 模式参数透传（V4 的 reasoning effort 后续按需再加）。

## 验收

1. `pnpm build && pnpm test:all && pnpm typecheck:app` 全绿。
2. 用户重新打包 App 后：列表出现 V4 Pro / V4 Flash，各发一轮正常流式；auto 模式简单问题命中 Flash。
3. 旧会话（modelKey=deepseek-v3）打开不报错（服务端映射仍在）。
