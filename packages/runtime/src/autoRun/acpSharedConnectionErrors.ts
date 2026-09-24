import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { AcpAuthenticationOutcome } from "./acpAuthentication.js";

export class AcpSharedConnectionLostError extends Error {
  constructor(message = "ACP shared connection was lost.") {
    super(message);
    this.name = "AcpSharedConnectionLostError";
  }
}

export class AcpSharedConnectionShutdownError extends Error {
  constructor(message = "ACP shared connection provider has shut down.") {
    super(message);
    this.name = "AcpSharedConnectionShutdownError";
  }
}

export class AcpSharedConnectionCleanupError extends Error {
  constructor(cause: unknown) {
    super("ACP shared connection cleanup failed.", { cause });
    this.name = "AcpSharedConnectionCleanupError";
  }
}

export class AcpSharedConnectionAuthRequiredError extends Error {
  constructor(
    readonly outcome: Extract<AcpAuthenticationOutcome, { kind: "auth_required" }>,
    readonly initialized: InitializeResponse,
    message = "ACP shared connection requires interactive authentication."
  ) {
    super(message);
    this.name = "AcpSharedConnectionAuthRequiredError";
  }
}
