// src/logger.ts
import pino from "pino";

/** Structured JSON logger. Level is configurable via LOG_LEVEL. */
export function createLogger(scope: string) {
  return pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    base: { scope, service: "bannerforge" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
