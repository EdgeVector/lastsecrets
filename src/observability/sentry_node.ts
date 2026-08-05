import type { SentryModule } from "./sentry.ts";

export async function loadSentryNodeModule(): Promise<SentryModule> {
  try {
    const moduleName = "@sentry/node";
    return (await import(moduleName)) as SentryModule;
  } catch (error) {
    throw new Error(
      "OBS_SENTRY_DSN is set but @sentry/node is not installed; add it to the consuming Bun/TS repo",
      { cause: error },
    );
  }
}
