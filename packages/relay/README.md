# @pocket-code/relay

设备配对 + 消息中继 + HTTP/WS 反向隧道服务（类 ngrok，单租户共享密钥模型）。
零业务逻辑：只做鉴权、路由与隧道帧转发；协议定义见
[`@pocket-code/protocol-core`](../protocol-core)。内网侧客户端见
[`@pocket-code/tunnel-client`](../tunnel-client)（或 pocket-code daemon）。

## 架构

```
浏览器 ──HTTP/WS──► relay(公网) ◄──WS 控制连接── tunnel-client / daemon(内网)
   subdomain(默认): <id>-<port>.<域>   │ daemon-register(HMAC) + heartbeat
   path: /t/<id>/<port>/(+pc_tunnel)  │ tunnel-request/response/chunk/end
                                      │ tunnel-ws-open/data/close(HMR)
App ──ws /relay──► relay ──forward──► daemon(配对/业务转发,可用 RELAY_DISCOVERY 关闭)
```

隧道寻址有两种模式(`TUNNEL_MODE`,默认 `subdomain`),形态与取舍见下方
[隧道寻址模式](#隧道寻址模式)一节。

## 快速开始（纯隧道用法）

```bash
# 公网机:起 relay(强制共享密钥;纯隧道部署建议关闭发现与配对)
export RELAY_SECRET=$(openssl rand -hex 32)
export RELAY_DISCOVERY=off
export TUNNEL_TOKEN=$(openssl rand -hex 16)   # 强烈建议:隧道入口鉴权
pnpm --filter @pocket-code/relay build && node packages/relay/dist/index.js

# 内网机:起隧道客户端(同一 RELAY_SECRET;未发布 npm 前在本仓内用:
#   node packages/tunnel-client/dist/cli.js ...)
pocket-tunnel --relay wss://your-host/relay --secret $RELAY_SECRET
# 输出 machineId 后,浏览器访问(取决于 TUNNEL_MODE):
#   subdomain(默认): https://<machineId>-<本机端口>.<TUNNEL_BASE_DOMAIN>/?pc_token=<TUNNEL_TOKEN>
#   path:            https://your-host/t/<machineId>/<本机端口>/?pc_token=<TUNNEL_TOKEN>
```

## 配置（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3200 | 监听端口 |
| `RELAY_SECRET` | 必填 | 与所有 tunnel-client/daemon 共享的注册密钥（HMAC-SHA256） |
| `RELAY_DISCOVERY` | on | `off` 时拒绝 list-machines 与 pair-request 转发（纯隧道部署姿态） |
| `TUNNEL_TOKEN` | 关闭 | 设置后隧道入口强制鉴权：首次 `?pc_token=<值>`，校验通过种 `pc_tunnel_token` HttpOnly cookie；失败一律 404 |
| `TUNNEL_COOKIE_SECURE` | on | `pc_tunnel_token` cookie 是否附加 `Secure`。VPS 裸 IP/纯 http 部署设 `off`（否则浏览器拒存 cookie，后续子资源 404；首次带 `?pc_token` 的请求不受影响） |
| `TUNNEL_MODE` | 隧道寻址模式:`subdomain`(默认,完整解法)/ `path`(路径前缀,裸 IP/无泛证书回退) | `subdomain` |
| `TUNNEL_BASE_DOMAIN` | 子域模式必需,如 `tunnel.example.com`;缺失则启动失败 | (无) |

## 隧道寻址模式

- **subdomain(默认)**:`https://<machineId>-<port>.<TUNNEL_BASE_DOMAIN>/`。应用绝对路径天然正确、
  链接可分享、SPA 客户端路由不掉前缀。需泛域名 + 泛证书。
- **path**(`TUNNEL_MODE=path`):`https://<host>/t/<machineId>/<port>/`。用于裸 IP / 无泛证书部署。
  服务端 3xx 重定向经 relay 补 `/t/<id>/<port>` 前缀不掉出;但 SPA 纯客户端 `pushState`、
  多机器并用会串——完整解请用 subdomain 模式。

> **破坏性变更**:默认模式为 `subdomain`。现有靠 `/t/` 路径的部署升级后**必须显式设 `TUNNEL_MODE=path`**,
> 否则启动会因缺 `TUNNEL_BASE_DOMAIN` 而失败(subdomain 模式硬要求 baseDomain)。

## 子域模式证书(Cloudflare DNS-01 泛证书,推荐)

要覆盖 `*.<TUNNEL_BASE_DOMAIN>`(二级子域通配)。Cloudflare 免费 Universal SSL **不覆盖**二级通配,
推荐让 Cloudflare 只当 DNS 供应商,证书由 Let's Encrypt DNS-01 签(免费,TLS 在自管 nginx 终止):

1. Cloudflare 建 API Token,权限 `Zone.DNS:Edit`。
2. VPS 装 `certbot` + `python3-certbot-dns-cloudflare`,用该 token 签 `*.tunnel.example.com`(+ `tunnel.example.com`)。
3. nginx `server { server_name *.tunnel.example.com; ... }` 反代 relay,证书指向泛证书;certbot 定时续签。
4. 泛 DNS 记录 `*.tunnel.example.com` → relay VPS IP。

备选:Cloudflare 付费 ACM(边缘终止,需橙云代理)。

## machineId 迁移(纯 hex)

machineId 从 `m_<hex>` 改为纯 `<hex>`(DNS-safe)。升级后**已配对设备需重新配对**:
删除 `~/.pocket-code/machine-id`(daemon)与 `~/.pocket-tunnel.json`(pocket-tunnel CLI),重启后自动生成新 id 并重新配对。

## 安全模型（务必阅读）

分三层：

1. **端点注册与帧路由（强）**：注册走 `RELAY_SECRET` 的 HMAC 挑战（5 分钟时间窗防重放）；
   响应/隧道/心跳帧与注册身份绑定——连上也收不到、答不了别人机器的帧。
   这是**单租户共享密钥**设计：知道密钥即可注册端点，不适合直接多租户开放。
2. **传输**：TLS/wss 由前置反代（nginx）承担，见部署一节。
3. **浏览器侧隧道入口（默认弱，建议加固）**：未设 `TUNNEL_TOKEN` 时，
   `machineId`（64 位熵,16 个 hex 字符）就是唯一能力凭证——知道它即可浏览对应内网端口。
   它会出现在 URL/日志/浏览器历史中，请视为秘密；公网部署强烈建议设置
   `TUNNEL_TOKEN` 并配合 `RELAY_DISCOVERY=off`（否则任意 WS 连接可枚举在线 machineId）。

已知后置项（多用户/公开服务前必做）：per-machine 指纹（TOFU）、多租户隔离、
App→relay 连接鉴权。另注意目标页面外链的 Referer 可能泄漏含 machineId 的路径。
另注意 `pc_token` 为 relay 保留查询参数名——无论是否启用 TUNNEL_TOKEN，它都会在转发前被剥除，内网服务不应复用该参数名。

## 部署

生产部署（systemd/pm2 + nginx wss 终止）见仓库
[`docs/deployment-relay-daemon.md`](../../docs/deployment-relay-daemon.md)（relay 部分同样适用于纯隧道模式）。

## 协议

入站边界统一 `RelayInbound.safeParse`（zod）。信封 `payload` 为不透明对象——
relay 不认识业务协议，业务校验由隧道两端兜底。完整 schema 见
`packages/protocol-core/src/`（信封/配对/隧道帧/边界 union 四个文件即协议全文）。

## License

MIT
