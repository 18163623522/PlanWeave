import { remoteRunnerEventServerCapabilitySchema } from "@planweave-ai/agent-host-protocol";
import type { HostTransportClock } from "./hostTransport.js";
import { classifyRemoteRunnerHttpFailure } from "./remoteRunnerHttpFailure.js";
export { parseRemoteRunnerRetryAfter } from "./remoteRunnerHttpFailure.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const CONFIGURATION_CODES = new Set([
  "ERR_INVALID_URL",
  "ERR_INVALID_PROTOCOL",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_REVOKED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "UND_ERR_INVALID_ARG"
]);

export type RemoteRunnerDiscoveryErrorKind =
  | "retryable"
  | "auth"
  | "protocol"
  | "configuration"
  | "cancelled"
  | "unknown";

export class RemoteRunnerDiscoveryError extends Error {
  constructor(
    readonly kind: RemoteRunnerDiscoveryErrorKind,
    readonly code: string,
    readonly retryAfterMs?: number
  ) {
    super(code);
    this.name = "RemoteRunnerDiscoveryError";
  }
}

export function selectRemoteRunnerEventProtocolVersion(capability: unknown): 2 {
  const parsed = remoteRunnerEventServerCapabilitySchema.safeParse(capability);
  if (!parsed.success || !parsed.data.available) {
    throw new RemoteRunnerDiscoveryError("protocol", "remote_runner_event_v2_required");
  }
  return 2;
}

function classifyRequestFailure(error: unknown): RemoteRunnerDiscoveryError {
  const seen = new Set<object>();
  let retryable = false;
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") {
      if (CONFIGURATION_CODES.has(current.code)) {
        return new RemoteRunnerDiscoveryError(
          "configuration",
          "remote_runner_discovery_configuration"
        );
      }
      if (RETRYABLE_NETWORK_CODES.has(current.code)) {
        retryable = true;
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  if (retryable) {
    return new RemoteRunnerDiscoveryError("retryable", "remote_runner_discovery_network");
  }
  return new RemoteRunnerDiscoveryError("unknown", "remote_runner_discovery_unknown");
}

export async function discoverRemoteRunnerEventProtocol(options: {
  url: URL;
  request: typeof fetch;
  signal: AbortSignal;
  clock: Pick<HostTransportClock, "now" | "setTimeout" | "clearTimeout">;
}): Promise<2> {
  const { url, request, signal, clock } = options;
  const controller = new AbortController();
  const deadline = clock.now().getTime() + DISCOVERY_TIMEOUT_MS;
  let timedOut = false;
  const abort = () => controller.abort();
  const checkCancellation = () => {
    if (signal.aborted) {
      throw new RemoteRunnerDiscoveryError("cancelled", "remote_runner_discovery_cancelled");
    }
    if (timedOut || clock.now().getTime() >= deadline) {
      timedOut = true;
      controller.abort();
      throw new RemoteRunnerDiscoveryError("retryable", "remote_runner_discovery_timeout");
    }
  };
  checkCancellation();
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteRunnerDiscoveryError("configuration", "remote_runner_discovery_configuration");
  }
  signal.addEventListener("abort", abort, { once: true });
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DISCOVERY_TIMEOUT_MS);
  try {
    let response: Response;
    let text: string;
    try {
      response = await request(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      checkCancellation();
      if (!response.ok) {
        const code = `remote_runner_discovery_http_${response.status}`;
        const failure = classifyRemoteRunnerHttpFailure(
          response.status,
          response.headers.get("retry-after"),
          clock.now()
        );
        throw new RemoteRunnerDiscoveryError(failure.kind, code, failure.retryAfterMs);
      }
      text = await response.text();
      checkCancellation();
    } catch (error) {
      checkCancellation();
      if (error instanceof RemoteRunnerDiscoveryError) throw error;
      throw classifyRequestFailure(error);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RemoteRunnerDiscoveryError("protocol", "remote_runner_discovery_invalid_json");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new RemoteRunnerDiscoveryError("protocol", "remote_runner_discovery_invalid_response");
    }
    return selectRemoteRunnerEventProtocolVersion(
      "remoteRunnerEvents" in body ? body.remoteRunnerEvents : undefined
    );
  } finally {
    clock.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
