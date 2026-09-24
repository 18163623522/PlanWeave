import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acpConversationPageSchema,
  type AcpConversationPage
} from "@planweave-ai/agent-host-protocol";
import { RealProcessAcpHarness } from "./support/realProcessAcpHarness.js";
import { RealProcessLifecycleClient } from "./support/realProcessLifecycleClient.js";

const require = createRequire(import.meta.url);
const harnesses: RealProcessAcpHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function database(path: string) {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string
    ) => {
      prepare(sql: string): {
        get(...values: unknown[]): Record<string, unknown> | undefined;
        run(...values: unknown[]): unknown;
      };
      close(): void;
    };
  };
  return new DatabaseSync(path);
}

async function conversation(
  harness: RealProcessAcpHarness,
  operationId: string,
  action?: Record<string, unknown>
): Promise<AcpConversationPage> {
  const response = await fetch(
    `${harness.origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}/conversation`,
    {
      method: action ? "POST" : "GET",
      headers: {
        ...harness.authorizationHeaders(),
        ...harness.remoteAgentOwnerIdentityHeaders(),
        ...(action ? { "content-type": "application/json" } : {})
      },
      ...(action ? { body: JSON.stringify(action) } : {})
    }
  );
  const body: unknown = await response.json();
  if (response.status !== (action ? 202 : 200)) {
    throw new Error(`conversation_http_${response.status}:${JSON.stringify(body)}`);
  }
  return acpConversationPageSchema.parse(body);
}

describe("real-process conversation deadline", () => {
  it("holds a new turn while the prior ACP child is inside session close cleanup", async () => {
    const harness = await RealProcessAcpHarness.create({
      acpScenario: "load-capable-artifact",
      readinessTimeoutMs: 20_000
    });
    harnesses.push(harness);
    const client = new RealProcessLifecycleClient(harness, 60_000);
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "conversation-cleanup-source"
    });
    expect((await client.waitForTerminal(dispatched.operationId)).state).toBe("completed");
    const source = await conversation(harness, dispatched.operationId);
    if (!source.sessionId) throw new Error("conversation_source_session_missing");
    await harness.acpControl.pause(["session/close"]);
    const first = {
      kind: "prompt",
      turnId: "cleanup-first-turn",
      executionAttemptId: dispatched.executionAttemptId,
      sessionId: source.sessionId,
      text: "First cleanup follow-up"
    };
    await conversation(harness, dispatched.operationId, first);
    const paused = await harness.acpControl.waitUntilLifecycleContains(
      "paused session/close",
      30_000
    );
    const firstPid = Number(
      paused.findLast((line) => line.includes("paused session/close"))?.split(" ")[0]
    );
    expect(Number.isSafeInteger(firstPid)).toBe(true);
    const server = database(client.serverDatabasePath());
    try {
      server
        .prepare("UPDATE acp_conversation_turns SET expires_at=? WHERE turn_id=?")
        .run("2000-01-01T00:00:00.000Z", first.turnId);
    } finally {
      server.close();
    }
    expect((await conversation(harness, dispatched.operationId)).turns).toContainEqual(
      expect.objectContaining({ turnId: first.turnId, status: "failed" })
    );
    const second = { ...first, turnId: "cleanup-second-turn", text: "Second cleanup follow-up" };
    await conversation(harness, dispatched.operationId, second);
    await vi.waitFor(
      () => {
        const host = database(client.hostDatabasePath());
        try {
          expect(
            host
              .prepare("SELECT status FROM agent_host_conversation_turns WHERE turn_id=?")
              .get(second.turnId)
          ).toMatchObject({ status: "queued" });
        } finally {
          host.close();
        }
      },
      { timeout: 10_000, interval: 50 }
    );
    expect(
      (await harness.acpControl.readLifecycle()).filter((line) => line.endsWith("session/load"))
    ).toHaveLength(1);
    await harness.acpControl.resume();
    await vi.waitFor(
      async () => {
        expect((await conversation(harness, dispatched.operationId)).turns).toContainEqual(
          expect.objectContaining({ turnId: second.turnId, status: "completed" })
        );
      },
      { timeout: 30_000, interval: 100 }
    );
    const lifecycle = await harness.acpControl.readLifecycle();
    const released = lifecycle.indexOf(`${firstPid} resumed session/close`);
    const loads = lifecycle.flatMap((line, index) =>
      line.endsWith("session/load") ? [index] : []
    );
    expect(released).toBeGreaterThanOrEqual(0);
    expect(loads).toHaveLength(2);
    expect(loads[1]).toBeGreaterThan(released);
    expect((await conversation(harness, dispatched.operationId)).turns).toContainEqual(
      expect.objectContaining({
        turnId: first.turnId,
        status: "failed",
        error: "acp_conversation_deadline_exceeded"
      })
    );
  }, 120_000);

  it.each([
    "initialize",
    "session/prompt",
    "session/close"
  ] as const)("keeps an interrupted %s session excluded after Host restart", async (stage) => {
    const harness = await RealProcessAcpHarness.create({
      acpScenario: "load-capable-artifact",
      readinessTimeoutMs: 20_000
    });
    harnesses.push(harness);
    const client = new RealProcessLifecycleClient(harness, 60_000);
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "conversation-restart-source"
    });
    expect((await client.waitForTerminal(dispatched.operationId)).state).toBe("completed");
    const source = await conversation(harness, dispatched.operationId);
    if (!source.sessionId) throw new Error("conversation_source_session_missing");
    await harness.acpControl.pause([stage]);
    const first = {
      kind: "prompt",
      turnId: "restart-first-turn",
      executionAttemptId: dispatched.executionAttemptId,
      sessionId: source.sessionId,
      text: "Interrupted follow-up"
    };
    await conversation(harness, dispatched.operationId, first);
    const paused = await harness.acpControl.waitUntilLifecycleContains(`paused ${stage}`, 30_000);
    const acpPid = Number(
      paused.findLast((line) => line.includes(`paused ${stage}`))?.split(" ")[0]
    );
    const oldHostPid = harness.hostPid();
    const oldLastSeenAt = (await harness.waitForHostOnline()).lastSeenAt;
    expect((await harness.killHost("SIGKILL"))?.signal).toBe("SIGKILL");
    expect(harness.hostPid()).toBeUndefined();
    expect(oldHostPid).toEqual(expect.any(Number));
    await harness.acpControl.forceExit(42);
    await vi.waitFor(() => expect(() => process.kill(acpPid, 0)).toThrow(), {
      timeout: 10_000,
      interval: 50
    });
    await harness.acpControl.resume();
    await harness.restartHost({ previousLastSeenAt: oldLastSeenAt });
    await vi.waitFor(
      async () => {
        expect((await conversation(harness, dispatched.operationId)).turns).toContainEqual(
          expect.objectContaining({
            turnId: first.turnId,
            status: "failed",
            error: "acp_conversation_host_interrupted"
          })
        );
      },
      { timeout: 30_000, interval: 100 }
    );
    const second = { ...first, turnId: "restart-second-turn", text: "Do not overlap" };
    await conversation(harness, dispatched.operationId, second);
    await vi.waitFor(
      async () => {
        expect((await conversation(harness, dispatched.operationId)).turns).toContainEqual(
          expect.objectContaining({
            turnId: second.turnId,
            status: "failed",
            error: "acp_conversation_session_cleanup_unverified"
          })
        );
      },
      { timeout: 30_000, interval: 100 }
    );
    const host = database(client.hostDatabasePath());
    try {
      expect(
        host
          .prepare("SELECT cleanup_safe FROM agent_host_conversation_turns WHERE turn_id=?")
          .get(first.turnId)
      ).toMatchObject({ cleanup_safe: 0 });
    } finally {
      host.close();
    }
    expect(
      (await harness.acpControl.readLifecycle()).filter((line) => line.endsWith("session/load"))
    ).toHaveLength(stage === "initialize" ? 0 : 1);
  }, 120_000);

  it("keeps a new same-session turn behind a Server-expired turn until Host cleanup, then ignores the late terminal", async () => {
    const harness = await RealProcessAcpHarness.create({
      acpScenario: "load-capable-artifact",
      readinessTimeoutMs: 20_000
    });
    harnesses.push(harness);
    const client = new RealProcessLifecycleClient(harness, 60_000);
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "conversation-deadline-source"
    });
    expect((await client.waitForTerminal(dispatched.operationId)).state).toBe("completed");
    const source = await conversation(harness, dispatched.operationId);
    expect(source.available).toBe(true);
    if (!source.sessionId) throw new Error("conversation_source_session_missing");

    await harness.acpControl.pause(["session/prompt"]);
    const first = {
      kind: "prompt",
      turnId: "deadline-first-turn",
      executionAttemptId: dispatched.executionAttemptId,
      sessionId: source.sessionId,
      text: "First follow-up"
    };
    await conversation(harness, dispatched.operationId, first);
    const paused = await harness.acpControl.waitUntilLifecycleContains(
      "paused session/prompt",
      30_000
    );
    const firstPid = Number(
      paused.findLast((line) => line.includes("paused session/prompt"))?.split(" ")[0]
    );
    expect(Number.isSafeInteger(firstPid)).toBe(true);

    const server = database(client.serverDatabasePath());
    try {
      server
        .prepare("UPDATE acp_conversation_turns SET expires_at=? WHERE turn_id=?")
        .run("2000-01-01T00:00:00.000Z", first.turnId);
    } finally {
      server.close();
    }
    expect((await conversation(harness, dispatched.operationId)).turns).toContainEqual(
      expect.objectContaining({
        turnId: first.turnId,
        status: "failed",
        error: "acp_conversation_deadline_exceeded"
      })
    );

    const second = { ...first, turnId: "deadline-second-turn", text: "Second follow-up" };
    await conversation(harness, dispatched.operationId, second);
    await vi.waitFor(
      () => {
        const host = database(client.hostDatabasePath());
        try {
          expect(
            host
              .prepare("SELECT status FROM agent_host_conversation_turns WHERE turn_id=?")
              .get(second.turnId)
          ).toMatchObject({ status: "queued" });
        } finally {
          host.close();
        }
      },
      { timeout: 10_000, interval: 50 }
    );
    expect(
      (await harness.acpControl.readLifecycle()).filter((line) => line.endsWith("session/load"))
    ).toHaveLength(1);

    await harness.acpControl.resume();
    await vi.waitFor(
      async () => {
        const page = await conversation(harness, dispatched.operationId);
        expect(page.turns).toContainEqual(
          expect.objectContaining({ turnId: second.turnId, status: "completed" })
        );
      },
      { timeout: 30_000, interval: 100 }
    );
    const final = await conversation(harness, dispatched.operationId);
    expect(final.turns).toContainEqual(
      expect.objectContaining({
        turnId: first.turnId,
        status: "failed",
        error: "acp_conversation_deadline_exceeded"
      })
    );
    const lifecycle = await harness.acpControl.readLifecycle();
    const loads = lifecycle.flatMap((line, index) =>
      line.endsWith("session/load") ? [index] : []
    );
    const prompts = lifecycle.flatMap((line, index) =>
      /^\d+ session\/prompt$/.test(line) ? [index] : []
    );
    expect(loads).toHaveLength(2);
    expect(prompts).toHaveLength(3);
    expect(loads[1]).toBeGreaterThan(prompts[1]);
    expect(lifecycle.some((line) => line.startsWith(`${firstPid} session/prompt`))).toBe(true);
  }, 120_000);
});
