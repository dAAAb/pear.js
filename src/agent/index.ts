// The agent: the model client and the turn loop of PEAR's robot station (pear/deploy/station/agent_loop), ported
// file by file. A page makes a VLLMClient with the system prompt of src/protocol, a StationAgentLoop on a robot of
// the station module, and calls step() once a turn. tests/agent compares both with PEAR's own.

export { ModelCall, StationAgentLoop } from "./agent_loop";
export type { HoldingRobot, StationAgentLoopOptions, Turn } from "./agent_loop";
export {
  checkScope,
  ContextLimit,
  ModelClient,
  RequestCancelled,
  SessionLost,
  TurnProgress,
  urlParts,
} from "./clients/client";
export type { Request } from "./clients/client";
export { HealthChecks } from "./clients/health_checks";
export { isPythonInt, Performance, pythonSum, RequestStatus, TokenRate } from "./clients/metrics";
export {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  OpenAIError,
  PermissionDeniedError,
  RateLimitError,
  SSEDecoder,
  SSELineDecoder,
  statusError,
  UnprocessableEntityError,
} from "./clients/openai";
export type { ServerSentEvent } from "./clients/openai";
export {
  base64Of,
  HealthStatus,
  ModelEvent,
  modelInput,
  modelOutput,
  modelOutputRecord,
  ModelPhase,
  ReasoningKind,
} from "./clients/schemas";
export type {
  CameraImage,
  Compaction,
  ContextTokens,
  EventData,
  EventHandler,
  ModelHealth,
  ModelInput,
  ModelOutput,
  ReferenceImage,
  RequestUsage,
  Usage,
} from "./clients/schemas";
export { ImageCacheMiss, pythonJsonLength, VLLMClient, VLLMProgress } from "./clients/vllm";
export type { HistoryMessage, VLLMClientOptions } from "./clients/vllm";
export { monotonic, sleep } from "./clock";
export type { Clock, Sleep } from "./clock";
export { ModelsConfig, OfferedModel } from "./config";
export type { ModelClientClass } from "./config";
export {
  isValueError,
  motionErrorOf,
  OperatorPaused,
  pythonErrorMessage,
  pythonErrorName,
  PythonException,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "./exceptions";
export { SINGLE_ARM_POSE_FORMAT, WRIST_CAMERA } from "./formats";
export { JPEG_QUALITY, ObservationMessage, uuid4 } from "./messages";
export { ActionMode, ActionPhase, resultRecord } from "./robot";
export type {
  ActionFormat,
  AgentRobot,
  Awaitable,
  Camera,
  CameraTimestamps,
  ControlSnapshot,
  Observation,
} from "./robot";
export { TurnEvent, TurnPhase } from "./schemas";
export type { TurnEventHandler } from "./schemas";
