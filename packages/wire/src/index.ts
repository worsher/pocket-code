// ── @pocket-code/wire ────────────────────────────────────
// Shared protocol definitions for App ↔ Relay ↔ Daemon.

// Business message schemas (original pocket-code messages)
export {
  RegisterMessage,
  InitMessage,
  MessageMessage,
  ToolExecMessage,
  ListFilesMessage,
  ReadFileMessage,
  ListSessionsMessage,
  DeleteSessionMessage,
  DeleteProjectWorkspaceMessage,
  GetQuotaMessage,
  AbortMessage,
  SyncPullMessage,
  SyncFileMessage,
  WsMessage,
  type WsMessageType,
} from "./messages.js";

// Normalized agent event protocol (consumed by the App's render layer)
export {
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileChangedEvent,
  CommandOutputEvent,
  ProcessStartedEvent,
  ProcessExitedEvent,
  PreviewAvailableEvent,
  ModelSelectedEvent,
  UsageEvent,
  DoneEvent,
  ErrorEvent,
  AgentEvent,
  type AgentEventType,
} from "./agentEvent.js";

// ── 协议核心层(已拆至 @pocket-code/protocol-core,此处聚合 re-export 保持导入路径兼容) ──
export {
  // 信封
  RelayRequest, ForwardRequest, ForwardResponse, RelayResponse, ForwardStream, RelayStream,
  type RelayRequestType, type ForwardRequestType, type ForwardResponseType,
  type RelayResponseType, type ForwardStreamType, type RelayStreamType,
  // 配对/发现
  PairRequest, PairResponseSuccess, PairResponseError, PairResponse,
  DaemonRegister, DaemonHeartbeat, ListMachines, MachineInfo, ListMachinesResponse,
  type PairRequestType, type PairResponseType, type DaemonRegisterType,
  type DaemonHeartbeatType, type ListMachinesType, type MachineInfoType, type ListMachinesResponseType,
  // 隧道帧
  TunnelRequest, TunnelResponse, TunnelChunk, TunnelEnd,
  TunnelWsOpen, TunnelWsOpened, TunnelWsData, TunnelWsClose, TunnelFrame,
  type TunnelRequestType, type TunnelResponseType, type TunnelChunkType, type TunnelEndType,
  type TunnelWsOpenType, type TunnelWsOpenedType, type TunnelWsDataType, type TunnelWsCloseType, type TunnelFrameType,
  // 边界 union
  RelayErrorMessage, DaemonRegistered, RelayInbound, DaemonInbound,
  type RelayErrorMessageType, type DaemonRegisteredType, type RelayInboundType, type DaemonInboundType,
} from "@pocket-code/protocol-core";

// Server outbound responses (P6b: control-response contracts)
export {
  AuthMsg,
  SessionMsg,
  QuotaMsg,
  FileListMsg,
  FileContentMsg,
  SyncManifestMsg,
  SyncFileContentMsg,
  SessionsListMsg,
  SessionDeletedMsg,
  ProjectWorkspaceDeletedMsg,
  ServerErrorMsg,
  ServerOutbound,
  type ServerOutboundType,
} from "./serverOutbound.js";
