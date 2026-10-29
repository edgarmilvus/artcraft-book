export type MethodName =
  | "auth"
  | "engine.execute"
  | "command.list"
  | "ui.screenshot";

export interface Frame {
  id: number | "auth";
  method: MethodName;
  params: Record<string, unknown>;
}

export interface FrameResponse {
  id: number | "auth";
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface CraftLiveClient {
  connect(): Promise<void>;                        // sends auth frame, throws AuthFailedError
  execute<R>(method: MethodName, params: unknown): Promise<R>;
  screenshot(): Promise<string /* path */>;
  close(): Promise<void>;
}

// Type guards the tool must implement.
export declare function isBatchResult(v: unknown): v is { steps: number; results: unknown[] };
export declare function isScreenshotResult(v: unknown): v is { path: string; bytes: number };
export declare function isPropertyGetResult(v: unknown): v is { path: string; value: number | number[] };
