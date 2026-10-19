import pino from "pino";
import { config } from "./config";

export const logger = pino({
  level: config.logLevel,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  // Container stdout is collected as JSON. A pretty transport starts a worker,
  // so reserve it for an interactive development terminal.
  ...(config.env === "development" && process.stdout.isTTY === true
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});
