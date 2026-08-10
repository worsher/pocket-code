# Workspace Storage v2 执行计划

**设计依据：** `docs/superpowers/specs/2026-08-10-workspace-storage-v2-design.md`  
**实施分支：** `codex/workspace-storage-v2`

## 阶段 0：冻结契约

- [x] 固化 Project/Replica/WorkspaceHandle、目录布局与单写者规则。
- [x] 固化 copy/linked/git 导入语义、来源去重和写回策略。
- [x] 固化三方同步、事务提交、异步作用域和旧布局迁移规则。
- [x] 建立跨端验收矩阵，覆盖手机创建、远端创建、模式切换、导入、删除、冲突和权限丢失。

## 阶段 1：共享 workspace-core

- [x] 新增 `@pocket-code/workspace-core` 纯 TypeScript 包。
- [x] 定义 Project、Replica、WorkspaceHandle、SourceIdentity 与 SyncEdge 类型。
- [x] 实现 project/replica ID 校验；新 ID 只接受 UUID，legacy ID 仅由迁移入口识别。
- [x] 实现统一相对路径验证，覆盖 POSIX/Windows/URI 编码穿越输入。
- [x] 实现来源身份推导和 strong/weak/none 去重判定。
- [x] 实现同步三方状态分类和事务 phase 状态机。
- [x] 将新包接入根 build/test，并通过单元测试。

## 阶段 2：Catalog v2 与目录解析

- [x] 设计可版本化 catalog schema，Project 与 Replica 分表/分记录存储。
- [x] 分别实现 mobile/server catalog repository，并加入用户作用域。
- [x] 实现 `WorkspaceResolver`，受管理路径只接受 catalog 分配的 storage key。
- [ ] 建立 `projects/<storage-key>/{worktree,state,cache}`、runtime、staging、trash。
- [ ] 移除 default project 的特殊目录语义，新建项目全部进入 v2。
- [x] 加入 catalog 原子写、损坏恢复和并发测试。

## 阶段 3：迁移路径消费者

- [ ] 文件 API 改为接收 `WorkspaceHandle` 与已验证相对路径。
- [ ] 命令执行、PTY/Terminal、Git、Preview 改为使用 handle 的能力和 root。
- [ ] 移除各模块的 `getWorkspaceRoot(projectId)` 与 fallback 到共享 workspace 的逻辑。
- [ ] 在适配层实现 realpath/文件句柄包含关系检查和 symlink 越界保护。
- [ ] 加入跨项目读写、绝对路径、`..`、symlink 和 stale generation 测试。

## 阶段 4：协议与异步作用域

- [ ] 扩展 wire schema：Project/Replica catalog、workspace generation 和 session scope。
- [ ] 文件事件补全 create/update/delete 与作用域字段。
- [x] 离线队列按 project/replica/session/generation 分区并在重放前重新验证。
- [ ] 项目切换时关闭旧订阅并以新 handle 建立连接。
- [ ] 保持旧协议兼容窗口，加入 mixed-version 测试。

## 阶段 5：导入与绑定

- [ ] 实现通用 import pipeline：probe → identity → duplicate check → stage → verify → catalog commit。
- [ ] 移动端目录/归档导入实现为 `copy`，处理权限中断和空间不足。
- [ ] daemon 实现 `linked` 绑定；state/shadow Git 存在管理目录而非用户仓库。
- [ ] Git URL 导入实现为 `git`，规范化 remote 并记录来源。
- [ ] UI 区分 strong duplicate、weak duplicate、权限丢失和独立副本。

## 阶段 6：事务同步与 writer handoff

- [ ] 以 replica edge 存储 base/local/remote snapshot。
- [ ] 实现 prepare/transfer/verify/apply/commit journal；失败不得推进 base。
- [ ] 支持删除传播、崩溃恢复、幂等重试和 staging 回收。
- [ ] 实现 writer lease 与模式切换 handoff，切换时递增 generation。
- [ ] 冲突时冻结自动写入并提供保留本地/远端/另存副本入口。

## 阶段 7：来源重导入与写回

- [ ] copy 项目支持显式重新导入，使用来源 snapshot 做三方判断。
- [ ] copy 项目支持显式导出/写回，默认预览变更并要求确认。
- [ ] linked 项目监测稳定 ID、权限与移动/删除状态。
- [ ] git 项目通过 commit/push 回写，不与文件覆盖协议混用。

## 阶段 8：旧布局迁移与发布

- [ ] 实现旧 mobile/server 目录探测和只读迁移 journal。
- [ ] 复制到 staging、校验、原子登记；迁移失败保留旧目录可继续打开。
- [ ] 通过 feature flag 分阶段启用 v2 catalog、resolver、protocol、import 和 sync。
- [ ] 观测目录冲突、stale event、同步失败、权限丢失和恢复成功率。
- [ ] 观察期后提供显式旧目录清理，不自动删除用户数据。
