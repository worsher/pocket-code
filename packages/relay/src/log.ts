/** 带 ISO 时间戳的 relay 日志(relay.ts / messageRouter.ts 共用)。 */
export function relayLog(message: string) {
  console.log(`[Relay ${new Date().toISOString()}] ${message}`);
}
