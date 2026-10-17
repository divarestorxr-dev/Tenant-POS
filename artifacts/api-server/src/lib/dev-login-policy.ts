/** Dev login is never available in production and can be explicitly disabled in DEV. */
export function isDevLoginEnabled(nodeEnv = process.env.NODE_ENV, flag = process.env.ENABLE_DEV_LOGIN): boolean {
  return nodeEnv !== "production" && flag !== "false";
}
