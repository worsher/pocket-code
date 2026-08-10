# Workspace Storage v2 设计

**状态：** 已确认，进入实现  
**日期：** 2026-08-10

## 1. 背景与问题

当前项目把“项目身份”“本地目录”和“当前运行模式”绑定在一起：移动端默认项目落在共享 `workspace`，其他项目落在 `workspace/<projectId>`；服务端则直接把客户端提供的 `projectId` 拼入 `~/.pocket-code/projects/<projectId>/workspace`。这会带来四类问题：

1. 手机创建、本地极客模式、云端模式之间切换时，同一个逻辑项目容易被解释成不同目录。
2. `projectId` 同时承担业务主键和路径片段，既不能稳定跨设备，也形成目录穿越风险。
3. 导入项目没有来源身份、导入模式和回写策略，无法可靠去重，也无法判断修改应写回哪里。
4. 当前同步是单向覆盖模型，缺少 replica 级同步基线、事务提交和异步作用域，部分失败或延迟事件可能污染另一个项目。

Workspace Storage v2 的目标是先建立统一且可验证的存储语义，再逐步迁移现有文件、命令、Git、预览、终端和同步调用链。

## 2. 核心模型

### 2.1 Project 与 Replica 分离

- **Project** 是跨设备稳定的逻辑项目，只保存身份、显示信息、来源和策略，不直接等同于某个文件路径。
- **Replica** 是 Project 在某个执行环境中的物理副本，例如手机副本、云端副本或开发机绑定目录。
- 每个新 Project 使用 UUID；旧项目 ID 作为不透明 catalog key 保留，仅用于迁移查找，绝不直接拼入文件路径。
- Project 可以在手机离线创建，联网后再由同步协议登记到远端；远端创建的 Project 同样通过 catalog 下发，而不是依赖两端路径一致。

### 2.2 WorkspaceHandle

所有文件、命令、Git、预览、终端和同步入口最终必须接收解析后的 `WorkspaceHandle`，不得自行根据 `projectId` 推导目录。

```ts
interface WorkspaceHandle {
  projectId: ProjectId;
  replicaId: ReplicaId;
  generation: number;
  storageUri: string;
  shellPath?: string;
  worktreeRoot: string;
  stateRoot: string;
  cacheRoot: string;
  capabilities: {
    read: boolean;
    write: boolean;
    execute: boolean;
    syncBack: boolean;
  };
}
```

- `storageUri` 用于文件系统适配器；`shellPath` 仅在存在真实、可执行的本机路径时提供。
- `generation` 在 replica 重新绑定、权限恢复或 writer 切换时递增，用于拒绝旧异步事件。
- `worktreeRoot` 只存用户项目内容；`stateRoot` 存同步基线、来源元数据和 shadow Git；`cacheRoot` 存可重建缓存。
- `capabilities` 是能力事实，不由 UI 模式名推断。

## 3. 目录设计

受管理 replica 统一采用：

```text
<pocket-code-data>/v2/
  catalog/
  projects/
    <storage-key>/
      worktree/
      state/
      cache/
  runtime/
  staging/
  trash/
```

- `storage-key` 由 catalog 分配并验证，不直接使用用户或客户端提供的 ID。
- 手机根目录为应用 Documents 下的 `pocket-code/v2`；云端根目录为服务端用户数据根下的 `pocket-code/v2`。
- runtime、临时下载和同步 staging 不得放进项目 worktree。
- “默认项目”不再拥有特殊目录；它只是 catalog 中的普通 Project。
- 外部 linked 项目的 `worktreeRoot` 可以指向受信任守护进程授权的原目录，但 `stateRoot` 与 `cacheRoot` 仍必须位于 Pocket Code 管理目录，避免污染用户仓库。

## 4. 模式切换与单写者

“本地极客模式”和“云端模式”是选择不同 replica，不是用另一套规则重新解释同一字符串路径。

模式切换采用 handoff 事务：

1. 冻结当前 writer 的新写入，并记录当前 snapshot。
2. 将当前 writer 与目标 replica 同步到可确认的共同状态。
3. 校验目标 replica、权限和能力。
4. 原子更新 active replica、writer lease 和 generation。
5. 新会话使用新的 `WorkspaceHandle`；旧 generation 的事件全部丢弃。

首个版本只允许一个 writer。镜像 replica 可以读取和同步，但不能在未取得 writer lease 时写入。实时多写者与自动语义合并不在本阶段范围内。

## 5. 导入语义

### 5.1 三种模式

| 模式 | worktree 位置 | 修改后的默认去向 | 适用环境 |
| --- | --- | --- | --- |
| `copy` | Pocket Code 受管理目录 | 只修改副本，不自动写回来源 | 手机、归档、一般目录导入 |
| `linked` | 原始外部目录 | 修改即发生在原目录 | 受信任桌面/daemon |
| `git` | Pocket Code clone | 通过 Git commit/push 返回 | 有 Git remote 的项目 |

手机通过系统目录选择器获得的路径默认导入为 `copy`。由于 iOS/Android 权限、URI 持久性和 shell 路径能力不一致，首版不把移动端外部目录当作稳定 linked workspace。

### 5.2 来源身份与去重

原始路径是去重维度之一，但不能作为唯一身份。`SourceIdentity` 由以下信号组合：

- 来源设备 ID；
- 文件系统稳定 ID 或平台持久 handle；
- canonical locator（规范化路径或 URI）；
- 规范化 Git remote；
- 可选内容指纹。

去重分级：

- **strong**：同一设备、同一稳定文件对象，且至少一个候选是 `linked`。阻止重复绑定，并引导用户打开既有 Project。
- **weak**：路径、Git remote、内容指纹或稳定来源相同，但导入是独立副本。提示可能重复，允许继续创建。
- **none**：没有足够证据认为来源相同。

路径相同但设备不同不能判定为同一物理目录；路径被删除后重新创建也不能仅凭字符串判为 strong duplicate。

### 5.3 回写策略

- `linked`：没有单独“同步回原路径”；用户修改直接作用于原目录。
- `git`：使用 Git 作为回写协议，不实现文件级双向覆盖。
- `copy`：首版只支持显式“重新导入”和“导出/写回”，默认不自动回写。
- 写回前以导入时的来源 snapshot 为 base 做三方比较；来源和副本都变化时进入 conflict，不自动覆盖。
- 来源权限丢失、稳定 ID 变化或 locator 指向新对象时进入 `permission-lost`/`missing`，必须重新确认绑定。

## 6. 同步模型

同步基线属于一条 replica edge，而不是 Project 全局状态：

```text
SyncEdge(projectId, localReplicaId, remoteReplicaId)
  baseSnapshot
  localSnapshot
  remoteSnapshot
  phase
```

三方决策：

- 两端都等于 base：`noop`
- 仅本端变化：`push`
- 仅远端变化：`pull`
- 两端已收敛到同一新 snapshot：`converged`
- 两端分别变化：`conflict`

一次同步必须经过 prepare → transfer → verify → apply → commit。只有全部文件校验和 apply 成功后才能推进 `baseSnapshot`。任何部分失败都保留旧 base，并把 staging 留给恢复/诊断流程；不得把部分成功记录成完整提交。

## 7. 异步作用域与安全边界

以下字段必须进入会跨异步边界的请求、事件、队列和响应：

```text
projectId + replicaId + sessionId + workspaceGeneration
```

- 离线队列重放前重新校验完整作用域；不匹配则丢弃或隔离。
- 文件事件必须带 create/update/delete 语义，不能只按内容覆盖。
- 服务端 catalog 必须按用户/租户隔离；客户端 ID 不能决定服务端物理路径。
- 所有相对路径先经过统一验证：拒绝绝对路径、反斜杠、NUL、URI 编码后的穿越片段和任意 `..` 段。
- 目录包含关系最终需要由平台适配器基于 realpath/文件句柄验证，纯字符串前缀不是安全判断。

## 8. 迁移与发布

迁移采用并存与惰性搬迁：

1. 读取旧 catalog 和旧目录，但所有新建/导入项目写入 v2。
2. 打开旧项目时建立 migration journal，复制到 staging，校验后原子登记 v2 replica。
3. 旧目录先保留为可恢复数据；观察期结束后再提供显式清理。
4. 使用 feature flag 分别启用 catalog v2、WorkspaceResolver、作用域协议、导入和事务同步。

## 9. 验收条件

### 9.1 跨端场景矩阵

| 场景 | 初始状态 | 预期结果 |
| --- | --- | --- |
| 手机离线创建 A，云端创建 B | 两端 catalog 暂未相遇 | 联网后出现两个 Project、两个独立 storage key，不按名称合并 |
| 手机创建 A 后首次进入云端模式 | 只有 mobile replica 有 snapshot | 创建 cloud replica并执行初始 push，完成后才移交 writer |
| 云端创建 B 后手机打开 | 只有 cloud replica 有 snapshot | 创建 mobile replica并执行初始 pull，不复用默认共享目录 |
| local writer 切换为 cloud writer | 两端存在共同 base | handoff 同步成功后递增 generation；旧事件失效 |
| 切换时两端均被修改 | local/remote 均偏离 base | 进入 conflict，不自动选择任一目录覆盖 |
| 同一目录重复 linked | 同设备稳定文件 ID 相同 | strong duplicate，阻止第二次绑定 |
| 同一路径字符串来自另一台设备 | device ID 不同 | 不判 strong duplicate，可独立导入 |
| 同一来源重复 copy | 来源 identity 相同 | weak duplicate 提示，用户仍可创建独立副本 |
| copy 修改后来源也变化 | 双方偏离导入 snapshot | 显式写回进入 conflict，不静默覆盖来源 |
| linked 权限或稳定 ID 丢失 | 外部绑定不可验证 | replica 进入 permission-lost/missing，重新授权前禁止写入 |
| 同步中部分文件失败 | apply/verify 未全部完成 | 保留旧 base，journal 可恢复，不能显示已同步 |
| 删除从 writer 同步到 mirror | 文件事件为 delete | 目标删除对应相对路径，并保留事务/冲突语义 |
| 切换后收到旧会话事件 | generation/session 不匹配 | 丢弃或隔离，不能写入当前 workspace |

### 9.2 完成标准

- 手机和远端各自创建的不同项目不会因显示名、legacy ID 或相同路径字符串发生目录碰撞。
- 同一 Project 在本地/云端切换时通过 replica handoff，不产生两个并发 writer。
- 文件、命令、Git、预览、终端和同步均不能绕过 `WorkspaceHandle` 自行拼路径。
- 同一 linked 目录被强去重；copy/git 的疑似重复只提示并允许独立副本。
- copy 导入不会静默覆盖原始路径；显式写回在双边变化时进入 conflict。
- 部分同步失败不推进 base，旧事件不能写入新的 project/replica/generation。
- 路径穿越、跨用户 catalog 访问、删除传播、权限丢失和崩溃恢复都有自动化测试。
