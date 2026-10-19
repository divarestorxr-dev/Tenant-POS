import { writeSync } from "node:fs";

let terminating = false;
let installed = false;

// A failed logging transport can itself emit an uncaught exception. Reporting
// that failure through the same logger creates an endless error/CPU loop.
// Use synchronous stderr and terminate: an uncaught error is not safe to resume.
export function exitOnUnhandledError(
  kind: "uncaughtException" | "unhandledRejection",
  reason: unknown,
): void {
  if (terminating) return;
  terminating = true;
  process.exitCode = 1;

  // Let the failed worker finish its current exit/close callbacks first.
  // Calling process.exit synchronously from its error event can run Pino's
  // exit hook before close and block in flushSync waiting for that dead worker.
  setImmediate(() => process.exit(1));

  try {
    let detail: string;
    try {
      detail = reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason);
    } catch {
      detail = "Error detail unavailable";
    }
    writeSync(2, `[fatal] ${kind}: ${detail.slice(0, 8_000)}\n`);
  } catch {
    // Even a closed stderr must not prevent termination or re-enter a logger.
  }
}

export function installProcessErrorHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => exitOnUnhandledError("uncaughtException", error));
  process.on("unhandledRejection", (reason) => exitOnUnhandledError("unhandledRejection", reason));
}
