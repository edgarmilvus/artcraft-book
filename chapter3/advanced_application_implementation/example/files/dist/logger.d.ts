import pino from "pino";
/** Structured JSON logger. Level is configurable via LOG_LEVEL. */
export declare function createLogger(scope: string): pino.Logger<never, boolean>;
