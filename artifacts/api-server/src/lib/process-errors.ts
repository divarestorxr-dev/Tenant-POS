import { writeSync } from "node:fs";

let terminating = false;
let installed = false;
const fatalCleanups = new Set<() => Promise<void>>();

export function registerFatalCleanup(cleanup: () => Promise<void>): () => void {
  fatalCleanups.add(cleanup);
  return () => { fatalCleanups.delete(cleanup); };
}

// A failed logging transport can itself emit an uncaught exception. Reporting
// that failure through the same logger creates an endless error/CPU loop.
// Use synchronous stderr and terminate: an uncaught error is not safe to resume.
export function exitOnUnhandledError(
  kind: "uncaughtException" | "unhandledRejection" | "loggingTransport",
  reason: unknown,
): void {
  if (terminating) return;
  terminating = true;
  process.exitCode = 1;

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

  // Resources own their cleanup. In particular, a Pino worker must emit close
  // before process.exit can run without invoking its stale flush-on-exit hook.
  // Waiting for an arbitrary event-loop turn does not establish that ordering.
  void Promise.allSettled([...fatalCleanups].map((cleanup) => cleanup()))
    .then(() => process.exit(1));
}

export function installProcessErrorHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => exitOnUnhandledError("uncaughtException", error));
  process.on("unhandledRejection", (reason) => exitOnUnhandledError("unhandledRejection", reason));
}
