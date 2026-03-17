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
  WsMessage,
  type WsMessageType,
} from "./messages.js";

// Pairing, registration, and discovery schemas
export {
  PairRequest,
  PairResponseSuccess,
  PairResponseError,
  PairResponse,
  DaemonRegister,
  DaemonHeartbeat,
  ListMachines,
  MachineInfo,
  ListMachinesResponse,
  type PairRequestType,
  type PairResponseType,
  type DaemonRegisterType,
  type DaemonHeartbeatType,
  type ListMachinesType,
  type MachineInfoType,
  type ListMachinesResponseType,
} from "./pairing.js";

// Relay envelope schemas
export {
  RelayRequest,
  ForwardRequest,
  ForwardResponse,
  RelayResponse,
  ForwardStream,
  RelayStream,
  type RelayRequestType,
  type ForwardRequestType,
  type ForwardResponseType,
  type RelayResponseType,
  type ForwardStreamType,
  type RelayStreamType,
} from "./relay.js";
