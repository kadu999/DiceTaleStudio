/** 服务端日志级别（WS 中枢与 HTTP 层共用）。 */
export type LogLevel = "info" | "warn" | "error";

/** 一条日志的去处：由进程入口注入（见 `apps/backend/src/index.ts` 的 `createLogger`）。 */
export type HubLogger = (level: LogLevel, message: string) => void;
