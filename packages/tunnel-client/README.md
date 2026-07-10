# @pocket-code/tunnel-client

pocket-code relay 的内网侧反向隧道客户端：注册（HMAC）、心跳、HTTP/WS 隧道帧转发。
附最小 CLI `pocket-tunnel`（tunnel-only：不含配对与 agent 业务，收到业务消息回明确错误帧）。

## CLI

```bash
pocket-tunnel --relay wss://your-host/relay --secret <RELAY_SECRET> [--name my-machine]
# env 兜底:RELAY_URL / RELAY_SECRET / MACHINE_NAME
# 身份持久化:~/.pocket-tunnel.json(首次生成 machineId,之后稳定复用)
```

启动后按输出的 machineId 访问：`https://your-host/t/<machineId>/<本机端口>/`
（relay 设置了 `TUNNEL_TOKEN` 时首次需带 `?pc_token=<值>`）。

## 库用法（嵌入宿主进程，如 pocket-code daemon）

```ts
import { startTunnelClient } from "@pocket-code/tunnel-client";

const handle = startTunnelClient({
  relayUrl: "wss://your-host/relay",
  relaySecret: process.env.RELAY_SECRET!,
  machineId: "m_xxxxxxxxxxxxxxxx",
  machineName: "my-box",
  // 可选:接管非隧道消息(pair-request/forward-request);不提供则回 tunnel-only 错误帧
  onMessage(msg, send) { /* 宿主业务 */ },
});
// handle.send(frame) / handle.stop()
```

隧道帧（tunnel-request、tunnel-ws-*）由包内自消化：HTTP 反代到 `localhost:<port>`，
WS 隧道对接本地 dev server（HMR 兼容，见 `src/tunnel.ts`）。断线自动指数退避重连。

## License

MIT
