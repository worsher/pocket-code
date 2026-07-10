// pm2 进程配置 —— 本机开发机常驻 daemon(可选常驻本地 relay)。
//
// 为什么需要:daemon 若挂在交互式 shell / 会话后台任务里,会话结束或被清理
// 时进程随之被杀,公网隧道立刻 502。pm2 让它脱离会话独立存活并自动重启。
//
// 用法(服务由你自己起,本文件只描述怎么起):
//   pnpm build:daemon                       # 先构建 dist/(relay 同理 build:relay)
//   pm2 start ecosystem.config.cjs --only pocket-daemon
//   pm2 logs pocket-daemon                  # 看日志
//   pm2 restart pocket-daemon               # 改代码 rebuild 后重启
//   pm2 stop pocket-daemon / pm2 delete pocket-daemon
//   pm2 save && pm2 startup                 # (可选)开机自启
//
// 两个进程都用编译产物 dist/index.js(等价各自 package.json 的 "start"),
// 且入口自身按 cwd→包根→仓库根三级加载 .env,所以 env 从仓库根 .env 读取。
// relay 默认不随 daemon 一起起 —— 本机通常连公网 VPS 上的 relay;只有需要
// "本地 relay ← 本地 daemon" 全链路自测时才 --only pocket-relay。

const { resolve } = require("path");
const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "pocket-daemon",
      cwd: repoRoot,
      script: resolve(repoRoot, "packages/daemon/dist/index.js"),
      autorestart: true,
      // 崩溃重启退避,避免配置错误(如 RELAY_SECRET 缺失)时疯狂重拉
      restart_delay: 2000,
      max_restarts: 10,
      time: true, // 日志加时间戳
    },
    {
      name: "pocket-relay",
      cwd: repoRoot,
      script: resolve(repoRoot, "packages/relay/dist/index.js"),
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      time: true,
    },
  ],
};
