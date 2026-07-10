// ── @pocket-code/protocol-core ───────────────────────────
// 与业务无关的中继协议层:信封、配对/发现、隧道帧、边界 union。
// relay 与 tunnel-client 只依赖本包;业务协议(WsMessage 等)留在 wire。

export {
  RelayRequest, ForwardRequest, ForwardResponse, RelayResponse, ForwardStream, RelayStream,
  type RelayRequestType, type ForwardRequestType, type ForwardResponseType,
  type RelayResponseType, type ForwardStreamType, type RelayStreamType,
} from "./envelope.js";

export {
  PairRequest, PairResponseSuccess, PairResponseError, PairResponse,
  DaemonRegister, DaemonHeartbeat, ListMachines, MachineInfo, ListMachinesResponse,
  type PairRequestType, type PairResponseType, type DaemonRegisterType,
  type DaemonHeartbeatType, type ListMachinesType, type MachineInfoType, type ListMachinesResponseType,
} from "./pairing.js";

export {
  TunnelRequest, TunnelResponse, TunnelChunk, TunnelEnd,
  TunnelWsOpen, TunnelWsOpened, TunnelWsData, TunnelWsClose, TunnelFrame,
  type TunnelRequestType, type TunnelResponseType, type TunnelChunkType, type TunnelEndType,
  type TunnelWsOpenType, type TunnelWsOpenedType, type TunnelWsDataType, type TunnelWsCloseType, type TunnelFrameType,
} from "./tunnel.js";

export {
  RelayErrorMessage, DaemonRegistered, RelayInbound, DaemonInbound,
  type RelayErrorMessageType, type DaemonRegisteredType, type RelayInboundType, type DaemonInboundType,
} from "./inbound.js";
