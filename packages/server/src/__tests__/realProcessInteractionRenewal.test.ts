import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exactPermissionRequestSchema,
  interactionSettlementSchema,
  parseExactPermissionSettlementForRequest
} from "@planweave-ai/agent-host-protocol";
import { RealProcessAcpHarness } from "./support/realProcessAcpHarness.js";
import { remoteAcpManifestParallelCapacity } from "./support/realProcessAcpManifests.js";
import {
  RealProcessLifecycleClient,
  type OperatorInteractionView
} from "./support/realProcessLifecycleClient.js";

const require = createRequire(import.meta.url);
const harnesses: RealProcessAcpHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function readRows(path: string, sql: string, ...values: unknown[]): Array<Record<string, unknown>> {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options: { readOnly: boolean }
    ) => {
      prepare(sql: string): { all(...values: unknown[]): Array<Record<string, unknown>> };
      close(): void;
    };
  };
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all(...values);
  } finally {
    database.close();
  }
}

async function createHarness(
  scenario: "permission" | "elicitation",
  options: { twoTasks?: boolean; pauseBeforePrompt?: boolean; hostClockOffsetMs?: number } = {}
) {
  const harness = await RealProcessAcpHarness.create({
    acpScenario: scenario,
    ...(options.twoTasks ? { manifest: remoteAcpManifestParallelCapacity() } : {}),
    hostClockOffsetMs: options.hostClockOffsetMs,
    readinessTimeoutMs: 20_000,
    serverLimits: {
      leaseDurationMs: 4_000,
      heartbeatIntervalMs: 1_000,
      hostOfflineAfterMs: 15_000
    }
  });
  harnesses.push(harness);
  const client = new RealProcessLifecycleClient(harness, 60_000);
  await harness.startAll();
  if (options.pauseBeforePrompt) await harness.acpControl.pause(["session/prompt"]);
  return { harness, client };
}

async function waitForTwoPersistedRenewals(
  harness: RealProcessAcpHarness,
  client: RealProcessLifecycleClient,
  dispatchId: string,
  initialExpiry: string
): Promise<string> {
  let latestExpiry = "";
  await vi.waitFor(
    () => {
      const renewals = readRows(
        client.serverDatabasePath(),
        "SELECT payload_json,occurred_at FROM dispatch_events WHERE dispatch_id=? AND type='lease.renewed' ORDER BY sequence",
        dispatchId
      );
      expect(renewals.length).toBeGreaterThanOrEqual(2);
      expect(Date.now()).toBeGreaterThan(Date.parse(initialExpiry));
      latestExpiry = String(JSON.parse(String(renewals.at(-1)?.payload_json)).leaseExpiresAt);
      const host = readRows(
        client.hostDatabasePath(),
        "SELECT lease_expires_at FROM agent_host_executions WHERE dispatch_id=?",
        dispatchId
      );
      expect(host).toHaveLength(1);
      expect(host[0].lease_expires_at).toBe(latestExpiry);
    },
    { timeout: 20_000, interval: 100 }
  );
  expect(harness.hostPid()).toEqual(expect.any(Number));
  return latestExpiry;
}

async function respond(
  client: RealProcessLifecycleClient,
  operationId: string,
  interaction: OperatorInteractionView,
  scenario: "permission" | "elicitation"
) {
  if (scenario === "permission") {
    const request = exactPermissionRequestSchema.parse(interaction.request);
    const option = request.options.find((candidate) => candidate.kind === "allow_once");
    if (!option) throw new Error("allow_once_option_missing");
    const settled = await client.settlePermission(operationId, interaction, {
      decision: "select_option",
      optionId: option.optionId
    });
    expect(settled.settlement).toMatchObject({
      type: "interaction.permission_response",
      decision: "select_option",
      optionId: option.optionId
    });
    return settled;
  }
  const settlement = interactionSettlementSchema.parse({
    type: "interaction.elicitation_response",
    actionId: interaction.request.actionId,
    dispatchId: interaction.request.dispatchId,
    leaseId: interaction.request.leaseId,
    executionAttemptId: interaction.request.executionAttemptId,
    acpSessionId: interaction.request.acpSessionId,
    outcome: "accepted",
    response: JSON.stringify({ value: "renewed-lease-answer" })
  });
  const result = await client.rawRequest({
    method: "POST",
    path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
    body: settlement
  });
  expect(result.status).toBe(200);
  const settled = result.body as OperatorInteractionView;
  expect(settled.settlement).toMatchObject({
    type: "interaction.elicitation_response",
    outcome: "accepted",
    response: JSON.stringify({ value: "renewed-lease-answer" })
  });
  return settled;
}

describe("real-process ACP interaction after lease renewal", () => {
  it.each([
    "permission",
    "elicitation"
  ] as const)("accepts a precise %s response after the initial lease expires", async (scenario) => {
    const { harness, client } = await createHarness(scenario, { pauseBeforePrompt: true });
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: `renewal-${scenario}`
    });
    const initialExpiry = dispatched.attempt.leaseExpiresAt;
    if (!initialExpiry) throw new Error("initial_lease_expiry_missing");
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    const renewedExpiry = await waitForTwoPersistedRenewals(
      harness,
      client,
      dispatched.dispatchId,
      initialExpiry
    );
    expect(Date.parse(renewedExpiry)).toBeGreaterThan(Date.parse(initialExpiry));
    await harness.acpControl.resume();

    const interaction = await client.waitForPendingInteraction(dispatched.operationId);
    expect(interaction.request).toMatchObject({
      type:
        scenario === "permission"
          ? "interaction.permission_requested"
          : "interaction.elicitation_requested",
      dispatchId: dispatched.dispatchId,
      leaseId: dispatched.attempt.leaseId,
      executionAttemptId: dispatched.executionAttemptId
    });
    expect(Date.parse(interaction.createdAt)).toBeGreaterThan(Date.parse(initialExpiry));
    const budgetMs = Date.parse(interaction.request.expiresAt) - Date.parse(interaction.createdAt);
    expect(budgetMs).toBeGreaterThan(14 * 60_000);
    expect(budgetMs).toBeLessThanOrEqual(15 * 60_000);
    const persisted = readRows(
      client.serverDatabasePath(),
      "SELECT status,expires_at FROM remote_interactions WHERE dispatch_id=? AND action_id=?",
      dispatched.dispatchId,
      interaction.request.actionId
    );
    expect(persisted).toEqual([{ status: "pending", expires_at: interaction.request.expiresAt }]);

    const settled = await respond(client, dispatched.operationId, interaction, scenario);
    expect(settled).toMatchObject({
      status: "settled",
      settlement: {
        actionId: interaction.request.actionId,
        dispatchId: dispatched.dispatchId,
        leaseId: dispatched.attempt.leaseId,
        executionAttemptId: dispatched.executionAttemptId
      }
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal).toMatchObject({
      state: "completed",
      dispatchStatus: "completed",
      runtime: { terminalReceipt: { outcome: "completed" } }
    });
    expect(client.readServerDispatch(dispatched.dispatchId).result_json).toBeTruthy();
    expect(client.readHostTerminalReceipt(dispatched.dispatchId)).toMatchObject({
      execution_attempt_id: dispatched.executionAttemptId,
      lease_id: dispatched.attempt.leaseId,
      terminal_kind: "completed"
    });
  }, 90_000);

  it.each([
    -10 * 60_000,
    10 * 60_000
  ])("keeps Server expiry at the local 15-minute budget with Host clock offset %i ms", async (hostClockOffsetMs) => {
    const { client } = await createHarness("permission", { hostClockOffsetMs });
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: `clock-offset-${hostClockOffsetMs}`
    });
    const interaction = await client.waitForPendingInteraction(dispatched.operationId);
    const budgetMs = Date.parse(interaction.request.expiresAt) - Date.parse(interaction.createdAt);
    expect(budgetMs).toBeGreaterThan(14 * 60_000);
    expect(budgetMs).toBeLessThanOrEqual(15 * 60_000);
    expect(
      readRows(
        client.serverDatabasePath(),
        "SELECT expires_at FROM remote_interactions WHERE dispatch_id=? AND action_id=?",
        dispatched.dispatchId,
        interaction.request.actionId
      )
    ).toEqual([{ expires_at: interaction.request.expiresAt }]);
    await respond(client, dispatched.operationId, interaction, "permission");
    expect((await client.waitForTerminal(dispatched.operationId)).state).toBe("completed");
  }, 90_000);

  it("cancels a pending permission, reaps its ACP child, and fences a late response from a new attempt", async () => {
    const { harness, client } = await createHarness("permission", { twoTasks: true });
    const first = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "renewal-cancel-old"
    });
    const pending = await client.waitForPendingInteraction(first.operationId);
    const lifecycle = await harness.acpControl.readLifecycle();
    const promptLine = lifecycle.find((line) => line.endsWith(" session/prompt"));
    const childPid = Number(promptLine?.split(" ")[0]);
    expect(Number.isSafeInteger(childPid)).toBe(true);

    await client.cancel(first.operationId, "cancel while ACP permission is pending");
    const cancelled = await client.waitForTerminal(first.operationId);
    expect(cancelled).toMatchObject({
      state: "cancelled",
      dispatchStatus: "cancelled",
      runtime: { terminalReceipt: { outcome: "cancelled" } }
    });
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), {
      timeout: 10_000,
      interval: 50
    });

    const second = await client.dispatch({
      blockRef: "T-002#B-001",
      idempotencyKey: "renewal-cancel-new"
    });
    const secondPending = await client.waitForPendingInteraction(second.operationId);
    expect(second.executionAttemptId).not.toBe(first.executionAttemptId);
    expect(secondPending.request.executionAttemptId).toBe(second.executionAttemptId);
    const oldRequest = exactPermissionRequestSchema.parse(pending.request);
    const oldOption = oldRequest.options.find((option) => option.kind === "allow_once");
    if (!oldOption) throw new Error("old_allow_once_option_missing");
    const late = parseExactPermissionSettlementForRequest(oldRequest, {
      type: "interaction.permission_response",
      actionId: oldRequest.actionId,
      dispatchId: oldRequest.dispatchId,
      leaseId: oldRequest.leaseId,
      executionAttemptId: oldRequest.executionAttemptId,
      acpSessionId: oldRequest.acpSessionId,
      decision: "select_option",
      optionId: oldOption.optionId
    });
    const rejected = await client.rawRequest({
      method: "POST",
      path: `/api/v1/remote-operations/${encodeURIComponent(first.operationId)}/interactions/respond`,
      body: late
    });
    expect(rejected.status).not.toBe(200);
    expect((await client.listInteractions(first.operationId))[0].status).toBe("pending");
    expect((await client.listInteractions(second.operationId))[0].status).toBe("pending");

    await respond(client, second.operationId, secondPending, "permission");
    expect((await client.waitForTerminal(second.operationId)).state).toBe("completed");
    expect((await client.observe(first.operationId)).state).toBe("cancelled");
  }, 120_000);

  it("ends the ACP child when the temporary Server disappears past the active lease", async () => {
    const { harness, client } = await createHarness("permission");
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "renewal-lost-server"
    });
    const pending = await client.waitForPendingInteraction(dispatched.operationId);
    const before = await client.observe(dispatched.operationId);
    const leaseExpiry = before.attempt.leaseExpiresAt;
    if (!leaseExpiry) throw new Error("active_lease_expiry_missing");
    const lifecycle = await harness.acpControl.readLifecycle();
    const promptLine = lifecycle.find((line) => line.endsWith(" session/prompt"));
    const childPid = Number(promptLine?.split(" ")[0]);
    expect(Number.isSafeInteger(childPid)).toBe(true);

    await harness.closeServerTransport();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(leaseExpiry)), {
      timeout: 15_000,
      interval: 50
    });
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), {
      timeout: 15_000,
      interval: 50
    });
    const host = readRows(
      client.hostDatabasePath(),
      "SELECT status FROM agent_host_executions WHERE dispatch_id=?",
      dispatched.dispatchId
    );
    expect(host).toHaveLength(1);
    expect(host[0].status).not.toBe("running");
    expect(host[0].status).not.toBe("interaction_wait");

    await harness.restartServer();
    const serverDispatch = client.readServerDispatch(dispatched.dispatchId);
    expect(serverDispatch.status).not.toBe("completed");
    expect(serverDispatch.result_json).toBeNull();
    const serverInteraction = readRows(
      client.serverDatabasePath(),
      "SELECT settlement_json FROM remote_interactions WHERE dispatch_id=? AND action_id=?",
      dispatched.dispatchId,
      pending.request.actionId
    );
    expect(serverInteraction).toEqual([{ settlement_json: null }]);
  }, 120_000);
});
