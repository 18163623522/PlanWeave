import { afterEach, describe, expect, it, vi } from "vitest";
import { scope } from "./support/canvasRuntimeServiceFixture.js";
import {
  createTimingFixture,
  deferred,
  type Invalidation
} from "./support/canvasRuntimeTimingFixture.js";

const preparation = vi.hoisted(() => ({
  afterSnapshot: undefined as (() => Promise<void>) | undefined
}));
vi.mock("@planweave-ai/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@planweave-ai/runtime")>();
  return {
    ...actual,
    capturePackageSnapshot: async (...args: Parameters<typeof actual.capturePackageSnapshot>) => {
      const result = await actual.capturePackageSnapshot(...args);
      await preparation.afterSnapshot?.();
      return result;
    }
  };
});
afterEach(() => {
  preparation.afterSnapshot = undefined;
});

const failures = ["deadline", "cancel", "disconnect", "lease_expired", "lease_released"] as const;
const errorFor = (kind: Invalidation) =>
  kind === "deadline"
    ? "deadline_exceeded"
    : kind === "lease_expired" || kind === "lease_released"
      ? "runtime_lease_expired"
      : "request_cancelled";

async function checkPreparation(operation: "complete" | "reset", kind: Invalidation) {
  const fixture = await createTimingFixture({
    leaseExpiresAt: kind === "lease_expired" ? "2030-01-01T00:00:01.000Z" : undefined
  });
  const before = await fixture.snapshot();
  const started = deferred();
  const finish = deferred();
  if (operation === "complete")
    fixture.artifactTransfer.download.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return fixture.bytes;
    });
  else
    preparation.afterSnapshot = async () => {
      preparation.afterSnapshot = undefined;
      started.resolve();
      await finish.promise;
    };
  const deadline = kind === "deadline" ? "2030-01-01T00:00:01.000Z" : undefined;
  const command =
    operation === "complete"
      ? fixture.complete(fixture.firstIdentity, "request-preparation", deadline)
      : fixture.reset("request-preparation", deadline);
  fixture.receive(command);
  const run = fixture.service.handle(command);
  await started.promise;
  expect(fixture.response(command.requestId)).toBeUndefined();
  await fixture.invalidate(kind, command.requestId);
  finish.resolve();
  await run;
  expect(fixture.response(command.requestId)).toMatchObject({
    response: { outcome: "error", error: { code: errorFor(kind), retryable: false } }
  });
  expect(await fixture.snapshot()).toEqual(before);
  const lease = fixture.state.canvasRuntime.lease(fixture.lease.runtimeLeaseId);
  expect(lease).toEqual(
    kind === "lease_released" ? { ...fixture.lease, status: "released" } : fixture.lease
  );
  if (operation === "reset")
    expect(fixture.state.canvasRuntime.resetStatus(scope, "operation-reset")).toMatchObject({
      kind: "failed",
      error: { code: errorFor(kind) }
    });
}

describe("Canvas Runtime asynchronous preparation", () => {
  it.each(
    failures
  )("rejects complete after download when %s invalidates admission", async (kind) => {
    await checkPreparation("complete", kind);
  });
  it.each(
    failures
  )("rejects reset after availability when %s invalidates admission", async (kind) => {
    await checkPreparation("reset", kind);
  });
  it("recovers a service-committed reset after its original deadline and replays without another reset", async () => {
    const fixture = await createTimingFixture();
    const started = deferred();
    const finish = deferred();
    let reads = 0;
    preparation.afterSnapshot = async () => {
      reads += 1;
      if (reads === 2) {
        preparation.afterSnapshot = undefined;
        started.resolve();
        await finish.promise;
      }
    };
    const original = fixture.reset("request-expiring-reset", "2030-01-01T00:00:01.000Z");
    fixture.receive(original);
    const run = fixture.service.handle(original);
    await started.promise;
    const committed = await fixture.snapshot();
    expect(committed.resetReceipt).toMatchObject({ operationId: "operation-reset" });
    expect(fixture.response(original.requestId)).toBeUndefined();
    await fixture.invalidate("deadline", original.requestId);
    finish.resolve();
    await run;
    expect(fixture.response(original.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "reconcile_required", retryable: true, reconcileRequired: true }
      }
    });
    const restarted = fixture.createService();
    const query = fixture.command(
      { operation: "reset_status", operationId: "operation-reset" },
      "request-recovery-query"
    );
    fixture.receive(query);
    await restarted.handle(query);
    expect(fixture.response(query.requestId)).toMatchObject({
      response: {
        outcome: "success",
        operation: "reset_status",
        result: { kind: "succeeded", result: { operationId: "operation-reset" } }
      }
    });
    const beforeReplay = await fixture.snapshot();
    fixture.receive(original);
    await restarted.handle(original);
    expect(await fixture.snapshot()).toEqual(beforeReplay);
    expect(fixture.response(original.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "reconcile_required" } }
    });
    expect(fixture.state.canvasRuntime.resetStatus(scope, "operation-reset")).toMatchObject({
      kind: "succeeded"
    });
    const durable = fixture.command(
      { operation: "reset_status", operationId: "operation-reset" },
      "request-durable-query"
    );
    const resolve = vi.fn(async () => {
      throw new Error("durable_query_must_not_resolve");
    });
    fixture.receive(durable);
    await fixture
      .createService({
        resolver: {
          configured: () => true,
          mappings: () => [],
          resolveProject: async () => fixture.canvas,
          resolve
        }
      })
      .handle(durable);
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.response(durable.requestId)).toMatchObject({
      response: { outcome: "success", result: { kind: "succeeded" } }
    });
  });
});
