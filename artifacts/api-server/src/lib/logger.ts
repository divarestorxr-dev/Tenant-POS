import pino from "pino";
import type { Worker } from "node:worker_threads";
import { config } from "./config";
import { exitOnUnhandledError, registerFatalCleanup } from "./process-errors";

const options: pino.LoggerOptions = {
  level: config.logLevel,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

function createPrettyTransport() {
  // thread-stream 3 exposes its Worker instance. Retain only this owned worker
  // so fatal cleanup can use Node's terminate() lifecycle without process hooks.
  const transport = pino.transport({
    target: "pino-pretty",
    options: { colorize: true },
  }) as ReturnType<typeof pino.transport> & { worker: Worker };

  let closeObserved = false;
  const closed = new Promise<void>((resolve) => {
    transport.once("close", () => {
      closeObserved = true;
      resolve();
    });
  });
  const unregister = registerFatalCleanup(async () => {
    if (closeObserved) return;
    // Do not end/flush a broken transport: those calls synchronously wait on
    // its worker. Termination is asynchronous, and close removes Pino's hooks.
    try {
      await transport.worker.terminate();
    } finally {
      await closed;
    }
  });
  transport.once("close", unregister);

  // Startup failures can originate on Worker before thread-stream can forward
  // them. Keep both listeners installed through close to absorb secondary errors.
  const fatal = (error: Error) => exitOnUnhandledError("loggingTransport", error);
  transport.worker.on("error", fatal);
  transport.on("error", fatal);
  return transport;
}

// Container stdout is collected as JSON. Reserve a pretty worker for an
// interactive development terminal, with an explicit fatal cleanup lifecycle.
export const logger = config.env === "development" && process.stdout.isTTY === true
  ? pino(options, createPrettyTransport())
  : pino(options);
