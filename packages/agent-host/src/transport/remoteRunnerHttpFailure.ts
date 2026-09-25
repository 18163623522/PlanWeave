const MAX_RETRY_AFTER_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function parseRemoteRunnerRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1_000, MAX_RETRY_AFTER_MS);
  const httpDate =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  if (!httpDate.test(text)) return undefined;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== text) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - now.getTime()));
}

export function classifyRemoteRunnerHttpFailure(
  status: number,
  retryAfter: string | null,
  now: Date
): { kind: "retryable" | "auth" | "protocol"; retryAfterMs?: number } {
  if (RETRYABLE_HTTP_STATUSES.has(status)) {
    return {
      kind: "retryable",
      retryAfterMs:
        status === 429 || status === 503 ? parseRemoteRunnerRetryAfter(retryAfter, now) : undefined
    };
  }
  return { kind: status === 401 || status === 403 ? "auth" : "protocol" };
}
