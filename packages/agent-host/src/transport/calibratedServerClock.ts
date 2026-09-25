import { systemHostTransportClock, type HostTransportClock } from "./hostTransport.js";

export class CalibratedServerClock {
  private offsetMs = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly localClock: Pick<HostTransportClock, "now"> = systemHostTransportClock
  ) {}

  synchronize(serverTime: string, localNow = this.localClock.now()): void {
    const serverMs = Date.parse(serverTime);
    if (!Number.isFinite(serverMs)) throw new Error("agent_host_server_time_invalid");
    this.offsetMs = serverMs - localNow.getTime();
    for (const listener of this.listeners) listener();
  }

  now(): Date {
    return new Date(this.localClock.now().getTime() + this.offsetMs);
  }

  remainingMs(serverDeadline: string): number {
    return Date.parse(serverDeadline) - this.now().getTime();
  }

  localDeadlineMs(serverDeadline: string): number {
    return Date.parse(serverDeadline) - this.offsetMs;
  }

  localDeadline(serverDeadline: string): Date {
    return new Date(this.localDeadlineMs(serverDeadline));
  }

  serverDeadline(localDeadline: Date): Date {
    return new Date(localDeadline.getTime() + this.offsetMs);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
