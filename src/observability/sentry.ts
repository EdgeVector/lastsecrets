export type SentryRuntimeEnvironment = Record<string, string | undefined>;

export type SentryInitOptions = {
  service: string;
  dsnEnv?: string;
  environmentEnv?: string;
  releaseEnv?: string;
  enabled?: boolean;
  installProcessHandlers?: boolean;
  env?: SentryRuntimeEnvironment;
  sentryModule?: SentryModule;
};

export type SentryInitResult =
  | { enabled: false; reason: "disabled" | "missing_dsn" }
  | { enabled: true; service: string; environment?: string; release?: string };

export type SentryModule = {
  init(options: {
    dsn: string;
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
    beforeSend?: (event: SentryEvent) => SentryEvent | null;
    initialScope?: {
      tags?: Record<string, string>;
    };
  }): void;
  captureException(error: unknown, context?: { tags?: Record<string, string> }): void;
  flush?(timeoutMs?: number): Promise<boolean>;
};

type SentryEvent = {
  exception?: {
    values?: Array<{
      value?: string;
    }>;
  };
  request?: {
    cookies?: unknown;
    headers?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
};

let installed = false;
let activeSentry: SentryModule | undefined;
let activeService: string | undefined;

export async function initSentry(options: SentryInitOptions): Promise<SentryInitResult> {
  const env = options.env ?? process.env;
  const dsnEnv = options.dsnEnv ?? "OBS_SENTRY_DSN";
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return { enabled: false, reason: "disabled" };
  }

  const dsn = env[dsnEnv]?.trim();
  if (!dsn) {
    return { enabled: false, reason: "missing_dsn" };
  }

  const sentry = options.sentryModule ?? (await loadSentryModule());
  const environment = env[options.environmentEnv ?? "OBS_SENTRY_ENVIRONMENT"];
  const release = env[options.releaseEnv ?? "OBS_SENTRY_RELEASE"];
  const service = options.service;

  sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    beforeSend: redactEvent,
    initialScope: {
      tags: {
        service,
      },
    },
  });

  activeSentry = sentry;
  activeService = service;

  if ((options.installProcessHandlers ?? true) && !installed) {
    installed = true;
    installProcessHandlers(sentry, service);
  }

  return {
    enabled: true,
    service,
    environment,
    release,
  };
}

export async function captureSentryException(
  error: unknown,
  tags: Record<string, string> = {},
): Promise<void> {
  if (!activeSentry) return;
  activeSentry.captureException(redactError(error), {
    tags: {
      ...(activeService ? { service: activeService } : {}),
      ...tags,
    },
  });
  await activeSentry.flush?.(2000);
}

async function loadSentryModule(): Promise<SentryModule> {
  const { loadSentryNodeModule } = await import("./sentry_node.ts");
  return loadSentryNodeModule();
}

function installProcessHandlers(sentry: SentryModule, service: string): void {
  process.on("uncaughtException", (error) => {
    sentry.captureException(redactError(error), {
      tags: { service, unhandled: "uncaughtException" },
    });
    void sentry.flush?.(2000).finally(() => {
      process.exitCode = 1;
    });
  });

  process.on("unhandledRejection", (reason) => {
    sentry.captureException(redactError(reason), {
      tags: { service, unhandled: "unhandledRejection" },
    });
    void sentry.flush?.(2000);
  });
}

function redactEvent(event: SentryEvent): SentryEvent {
  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (value.value) {
        value.value = redactSensitiveText(value.value);
      }
    }
  }

  if (event.request?.cookies) {
    event.request.cookies = "[redacted]";
  }

  if (event.request?.headers) {
    for (const key of Object.keys(event.request.headers)) {
      if (/authorization|cookie|token|key|secret/i.test(key)) {
        event.request.headers[key] = "[redacted]";
      }
    }
  }

  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (/password|token|secret|dsn|key/i.test(key)) {
        event.extra[key] = "[redacted]";
      } else if (typeof event.extra[key] === "string") {
        event.extra[key] = redactSensitiveText(event.extra[key]);
      }
    }
  }

  return event;
}

function redactError(error: unknown): unknown {
  if (error instanceof Error) {
    const redacted = new Error(redactSensitiveText(error.message));
    redacted.name = error.name;
    if (error.stack) {
      redacted.stack = redactSensitiveText(error.stack);
    }
    return redacted;
  }
  if (typeof error === "string") {
    return redactSensitiveText(error);
  }
  return error;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/lastsecrets:\/\/[a-z0-9][a-z0-9_-]*/gi, "lastsecrets://[redacted]")
    .replace(/\b[A-Za-z0-9_]*secret[A-Za-z0-9_-]*\b/g, "[redacted-secret]")
    .replace(/\b[A-Za-z0-9_]*token[A-Za-z0-9_-]*\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9_]*key[A-Za-z0-9_-]*\b/g, "[redacted-key]");
}
