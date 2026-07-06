# 部署说明：代理服务器(Relay) + 开发机器(Daemon)

> 适用于「公网中继」模式：手机 App ──► **Relay(VPS 公网)** ──► **Daemon(开发机/内网)**。
> Relay 只做转发与隧道，不执行业务；Daemon 内嵌 server 核心逻辑，AI 调用与工具执行都在开发机本地。

```
┌─────────┐   wss(:3200)   ┌──────────────────┐   出站 ws    ┌────────────────────┐
│  手机 App │ ◄───────────► │  Relay (VPS 公网)  │ ◄──────────► │  Daemon (开发机/内网)  │
│ WebView  │   /t 隧道      │  转发 + HTTP 隧道   │   主动连接   │  agent + 工具 + 同步   │
└─────────┘                └──────────────────┘             │  + dev server(:N)   │
                                                             └────────────────────┘
```

---

## 0. 前置条件

| | 要求 |
|---|---|
| Node | **>= 20**（Relay/Daemon 都用 Node 20+；daemon 用到全局 `fetch`/`ReadableStream`） |
| 包管理 | `pnpm` |
| Relay 机 | 一台有公网 IP 的 VPS（开放 :3200 或经 nginx 的 443） |
| 开发机 | 能出站访问 Relay；装 `git`；如用 **Claude Code 模型** 需装并登录 `claude` CLI |

---

## 1. 构建（两边都要，按依赖顺序）

```bash
git clone https://github.com/worsher/pocket-code.git
cd pocket-code
pnpm install

# 按依赖顺序构建(wire 在前)
pnpm --filter @pocket-code/wire build
pnpm --filter @pocket-code/server build
pnpm --filter @pocket-code/relay build    # Relay 机只需 wire+relay
pnpm --filter @pocket-code/daemon build    # 开发机需 wire+server+daemon
# 或一次性: pnpm build
```

> Relay 机其实只需要 `wire` + `relay` 两个包；开发机需要 `wire` + `server` + `daemon`。最省事是整仓 `pnpm install && pnpm build`。

---

## 2. 部署 Relay（VPS 公网）

### 2.1 环境变量

> 支持 `.env` 文件(每行一个 `KEY=VALUE`),不用 export。查找顺序:启动工作目录 → 包目录(`packages/relay/`) → **仓库根**;推荐放仓库根,任何启动方式都能找到。真实环境变量优先于 `.env`。

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3200` |
| `RELAY_SECRET` | **必填**(未设置 relay 拒绝启动)。Daemon 注册需 HMAC-SHA256 签名(防陌生 daemon 接入/顶替)。Relay 与 Daemon 必须用**同一个值**。生成:`openssl rand -hex 32` | 无(启动失败) |

### 2.2 直接运行（最简）

```bash
cd pocket-code
PORT=3200 RELAY_SECRET='换成你的随机长字符串' \
  pnpm --filter @pocket-code/relay start     # = node packages/relay/dist/index.js
```

Relay 监听 `ws://0.0.0.0:3200`，并提供：
- WebSocket：App ↔ Daemon 路由 + 配对
- `GET /health`：健康检查
- `*/t/<machineId>/<port>/*`：**反向 HTTP 隧道**（远程预览开发机 dev server，P5）

### 2.3 用 systemd 常驻（推荐）

`/etc/systemd/system/pocket-relay.service`：
```ini
[Unit]
Description=Pocket Code Relay
After=network.target

[Service]
WorkingDirectory=/opt/pocket-code
Environment=PORT=3200
Environment=RELAY_SECRET=换成你的随机长字符串
ExecStart=/usr/bin/node packages/relay/dist/index.js
Restart=always
RestartSec=3
User=pocket

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now pocket-relay
sudo journalctl -u pocket-relay -f    # 看日志
```

### 2.3b 用 pm2 常驻（systemd 的替代）

```bash
npm i -g pm2
cd /opt/pocket-code
```

在 `/opt/pocket-code/ecosystem.relay.config.js`（**含 RELAY_SECRET，勿提交 git**）：
```js
module.exports = {
  apps: [
    {
      name: "pocket-relay",
      script: "packages/relay/dist/index.js",
      cwd: "/opt/pocket-code",
      env: {
        PORT: "3200",
        RELAY_SECRET: "换成你的随机长字符串",
      },
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
```

```bash
pm2 start ecosystem.relay.config.js        # 启动
pm2 logs pocket-relay                       # 看日志
pm2 restart pocket-relay                    # 重启(改了 env/代码后)
pm2 save                                    # 记住当前进程列表
pm2 startup                                 # 生成开机自启命令(按提示执行一次)
```
> 不想写配置文件也可：`RELAY_SECRET=xxx PORT=3200 pm2 start packages/relay/dist/index.js --name pocket-relay`（pm2 会继承当前 shell 的环境变量）。

### 2.4 nginx + TLS（生产强烈建议，App 才能用 wss + https 隧道）

> 现有 `docker/nginx.conf` 是给「云端 server 模式」的(代理到 server:3100)，**Relay 模式要用下面这份**(代理到 relay:3200，且兼顾 WebSocket 与隧道流式)。

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    # WebSocket(App↔Daemon)与 /health
    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout  3600s;   # 长连接/流式
        proxy_send_timeout  3600s;
    }

    # 反向隧道(远程预览):关闭缓冲以支持流式;Upgrade 头支持 HMR WebSocket
    location /t/ {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;          # 隧道是分片流,不要缓冲
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
# certbot 申请证书: sudo certbot --nginx -d relay.example.com
```

配好后 App 里填 `wss://relay.example.com`（端口 443，省略）；隧道预览走 `https://relay.example.com/t/...`。

### 2.5 防火墙

```bash
# 裸跑(无 nginx): 放行 3200
sudo ufw allow 3200/tcp
# 有 nginx+TLS: 放行 443(和 80 给 certbot)
sudo ufw allow 80,443/tcp
```

---

## 3. 部署 Daemon（开发机/内网）

Daemon 主动出站连 Relay，内嵌 server 跑 AI 与工具，**不需要公网 IP、不暴露任何端口**。

### 3.1 环境变量（支持 `.env` 文件或 export）

> `.env` 查找顺序:启动工作目录 → 包目录(`packages/daemon/`) → **仓库根**;推荐放仓库根(`pnpm dev:daemon` 等 --filter 方式启动时 cwd 是包目录,也能找到)。真实环境变量优先于 `.env`。**勿提交 git**(已在 .gitignore)。

**连接 Relay：**
| 变量 | 说明 | 默认 |
|---|---|---|
| `RELAY_URL` | Relay 地址(用 wss 若 Relay 上了 TLS) | `ws://localhost:3200` |
| `RELAY_SECRET` | **必填**(未设置 daemon 拒绝启动),必须**与 Relay 的一致** | 无(启动失败) |
| `MACHINE_NAME` | 机器显示名 | 系统 hostname |
| `POCKET_HOME` | 配置/密钥目录 | `~/.pocket-code` |

**AI 模型 Key（按需，至少配一个；Daemon 内嵌 server 用这些跑 agent）：**
| 变量 | 用途 |
|---|---|
| `SILICONFLOW_API_KEY`(+`SILICONFLOW_BASE_URL`) | DeepSeek V3/R1、Qwen Coder |
| `ANTHROPIC_API_KEY` | Claude（API 方式） |
| `OPENAI_API_KEY` | GPT-4o |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini |
| `IFLOW_API_KEY`(+`IFLOW_BASE_URL`) | iFlow |
| `CLAUDE_CLI_PATH` | **Claude Code 模型**用的 `claude` CLI 路径(默认 `claude`,需先 `claude` 登录认证)。**此路径无需 API Key**，用你的 Claude 订阅 |

**其它（一般用默认）：**
| 变量 | 说明 | 默认 |
|---|---|---|
| `JWT_SECRET` | 内部认证密钥（设固定值避免重启后失效） | 自动生成到 `~/.pocket-code/jwt-secret` |
| `WORKSPACE_ROOT` / `PROJECTS_ROOT` | 工作区根目录 | `~/.pocket-code/{workspaces,projects}` |
| `DB_PATH` | SQLite 路径 | `~/.pocket-code/pocket-code.db` |

### 3.2 运行

```bash
cd pocket-code

# 示例:用 Claude Code 订阅 + DeepSeek
RELAY_URL='wss://relay.example.com' \
RELAY_SECRET='与 Relay 同一个值' \
MACHINE_NAME='my-dev-mac' \
SILICONFLOW_API_KEY='sk-xxx' \
  pnpm --filter @pocket-code/daemon start    # = node packages/daemon/dist/index.js
```

启动后终端会打印 **8 位配对码**（5 分钟有效，过期自动刷新）：
```
[Daemon] 📱 New pairing code: A3KP9XQ2
```

> 用 Claude Code 模型前：在开发机 `npm i -g @anthropic-ai/claude-code` 并 `claude`(交互登录一次)，确保 `claude --version` 能跑。

### 3.3 用 pm2 常驻（推荐，开发机一般不用 systemd）

```bash
npm i -g pm2
cd pocket-code
```

在 `pocket-code/ecosystem.daemon.config.js`（**含密钥，勿提交 git**）：
```js
module.exports = {
  apps: [
    {
      name: "pocket-daemon",
      script: "packages/daemon/dist/index.js",
      cwd: "/绝对路径/pocket-code",
      env: {
        RELAY_URL: "wss://relay.example.com",
        RELAY_SECRET: "与 Relay 同一个值",
        MACHINE_NAME: "my-dev-mac",
        // ── AI Key(按需) ──
        SILICONFLOW_API_KEY: "sk-xxx",
        // ANTHROPIC_API_KEY: "sk-ant-xxx",
        // OPENAI_API_KEY: "sk-xxx",
        // GOOGLE_GENERATIVE_AI_API_KEY: "xxx",
        // CLAUDE_CLI_PATH: "/Users/you/.local/bin/claude",  // 用 Claude Code 订阅
        // 固定 JWT_SECRET 避免重启失效(可选):
        // JWT_SECRET: "固定随机串",
      },
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
```

```bash
pm2 start ecosystem.daemon.config.js
pm2 logs pocket-daemon          # 看日志(里面会打印配对码)
pm2 restart pocket-daemon       # 改 env/代码后重启
pm2 save && pm2 startup         # 开机自启(按 startup 提示执行一次)
```

> ⚠️ 用 pm2 跑 Daemon 时，**配对码打印在 `pm2 logs pocket-daemon` 里**(不是当前终端)。
> macOS 用户注意：pm2 作为后台进程,要确保 `CLAUDE_CLI_PATH` 指向 `claude` 绝对路径(后台进程的 PATH 可能不含 `~/.local/bin`)。
> 不想写配置文件也可：把上面的 env 在 shell 里 `export` 后 `pm2 start packages/daemon/dist/index.js --name pocket-daemon`（pm2 继承 shell 环境变量）。

---

## 4. App 端配置（一次）

1. 设置 → 运行模式 → **云端模式**
2. 工作区(云端连接方式) → **公网中继 (Relay)**
3. 填 Relay 地址：`wss://relay.example.com`（裸跑则 `ws://你的VPS_IP:3200`）
4. 输入 Daemon 终端显示的**配对码** → 点「配对」
5. 配对成功后签发长期设备 JWT（365 天），以后无需再配对

---

## 5. 远程预览（P5 隧道）用法

开发机上 agent 启动了 dev server（如 `npm run dev` 在 `:5173`）后：
- App → Preview 页，地址栏输入端口 `5173`（或 `localhost:5173`）。**relay 模式下 App 会自动改写**为隧道 URL：`https://relay.example.com/t/<machineId>/5173/`。
- Relay 把请求经 Daemon 隧道转给开发机 `127.0.0.1:5173`，流式回传到 WebView。

**已知限制：** 路径式隧道对「绝对路径子资源」(如 vite 的 `/src/main.tsx`)会失效，**相对路径页面 / `vite build` 后的静态产物**可正常预览；HMR(热更新)暂不支持。需要完整 SPA 远程预览时，建议先 `vite build` 再预览 `dist/`（或用代码同步把 `dist/` 拉到手机本地预览）。

---

## 6. 安全建议

- `RELAY_SECRET` 已强制必填（Relay 与 Daemon 同值,未设置拒绝启动）;回帧身份绑定防已注册 daemon 伪造他人 requestId/tunnelId。
- **生产用 nginx + TLS**（wss/https）。裸 `ws://` 在 Android **release 包**会被系统拦截（明文流量）；调试用 debug 包或上 TLS。
- Relay 不持有任何业务数据/密钥；AI Key 只在开发机。
- 配对码 5 次输错自动销毁；设备可在开发机 `~/.pocket-code/authorized-devices.json` 撤销。

---

## 7. 排错速查

| 现象 | 排查 |
|---|---|
| App 连不上 | `curl https://relay.example.com/health` 是否 200；Relay 是否在跑；App 地址 wss/ws 与端口是否对 |
| 配对失败 | Daemon 是否打印了配对码且未过期(5min)；`RELAY_SECRET` 两端是否一致 |
| 注册被拒 | 日志 "Invalid authToken" → `RELAY_SECRET` 不一致或时钟不同步(>5min) |
| 预览空白/404 | 开发机 dev server 是否真在该端口；子资源绝对路径限制(见 §5) |
| Claude Code 模型报错 | 开发机 `claude --version` 是否可用、是否已登录；`CLAUDE_CLI_PATH` 是否正确 |

> 详细环境变量列表也可参考 `packages/server/.env.example`。
