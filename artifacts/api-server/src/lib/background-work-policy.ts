export type BackgroundWorkMode = "on-demand" | "scheduled";

/** DEV waits for authenticated work requests; production keeps its daily schedules. */
export function getBackgroundWorkMode(
  env: NodeJS.ProcessEnv = process.env,
): BackgroundWorkMode {
  const configured = env["TENANT_POS_BACKGROUND_MODE"]?.trim();
  if (configured === "on-demand" || configured === "scheduled") return configured;
  if (configured) {
    throw new Error("TENANT_POS_BACKGROUND_MODE must be on-demand or scheduled");
  }

  const isDevelopment = env["NODE_ENV"] !== "production"
    || env["APP_ENV"] === "development"
    || env["APP_ENV"] === "test";
  return isDevelopment ? "on-demand" : "scheduled";
}
