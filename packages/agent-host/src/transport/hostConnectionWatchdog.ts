import type { HostTransportClock } from "./hostTransport.js";

/** Bounds both the welcome handshake and silence on an otherwise open socket. */
export class HostConnectionWatchdog {
  private timer?: unknown;
  private timeoutMs = 30_000;

  constructor(
    private readonly clock: HostTransportClock,
    private readonly onTimeout: () => void
  ) {}

  received(heartbeatIntervalMs?: number): void {
    if (heartbeatIntervalMs !== undefined)
      this.timeoutMs = Math.max(30_000, heartbeatIntervalMs * 3);
    this.stop();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.onTimeout();
    }, this.timeoutMs);
  }

  stop(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
