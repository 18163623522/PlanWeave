import { describe, expect, it } from "vitest";
import { scope } from "./support/canvasRuntimeServiceFixture.js";
import {
  createTimingFixture,
  deferred,
  evidence,
  waitUntilResolved,
  type Invalidation
} from "./support/canvasRuntimeTimingFixture.js";

const requestFailures = ["deadline", "cancel", "disconnect"] as const;
const queuedOperations = ["activate", "fail", "complete", "reset", "acquire", "release"] as const;

async function queuedScenario(
  operation: "claim" | (typeof queuedOperations)[number],
  invalidation: Invalidation
) {
  const fixture = await createTimingFixture({
    secondPhase:
      operation === "activate"
        ? "prepared"
        : operation === "complete" || operation === "fail"
          ? "active"
          : "ready"
  });
  const started = deferred();
  const finish = deferred();
  fixture.artifactTransfer.download.mockImplementation(async () => {
    started.resolve();
    await finish.promise;
    return fixture.bytes;
  });
  const deadline = invalidation === "deadline" ? "2030-01-01T00:00:01.000Z" : undefined;
  const id = "request-queued";
  const identity = fixture.secondIdentity;
  const common = { runtimeLeaseId: fixture.lease.runtimeLeaseId, evidence: evidence(identity) };
  const queued =
    operation === "complete"
      ? fixture.complete(identity, id, deadline)
      : operation === "reset"
        ? fixture.reset(id, deadline)
        : fixture.command(
            operation === "acquire"
              ? { operation, contentTarget: fixture.target }
              : operation === "release"
                ? { operation, runtimeLeaseId: fixture.lease.runtimeLeaseId }
                : {
                    ...common,
                    operation,
                    input:
                      operation === "claim"
                        ? {
                            ref: identity.ref,
                            ...evidence(identity),
                            controlPlane: identity.controlPlane
                          }
                        : operation === "fail"
                          ? {
                              ...identity,
                              failure: {
                                code: "remote_test_failure",
                                message: "Failed.",
                                retryable: false
                              }
                            }
                          : identity
                  },
            id,
            deadline
          );
  const before = await fixture.snapshot();
  const first = fixture.complete(fixture.firstIdentity, "request-first");
  fixture.receive(first);
  const firstRun = fixture.service.handle(first);
  await started.promise;
  fixture.receive(queued);
  const queuedRun = fixture.service.handle(queued);
  await waitUntilResolved(fixture, 2);
  expect(fixture.response(id)).toBeUndefined();
  expect(fixture.state.canvasRuntime.lease(fixture.lease.runtimeLeaseId)).toEqual(fixture.lease);
  await fixture.invalidate(invalidation, id);
  if (invalidation === "cancel")
    expect(fixture.response(`cancel-${id}`)).toMatchObject({
      response: { outcome: "success", result: { cancelled: true } }
    });
  finish.resolve();
  await Promise.all([firstRun, queuedRun]);
  const after = await fixture.snapshot();
  expect.soft(fixture.response(id)).toMatchObject({
    response: {
      outcome: "error",
      error: {
        code: invalidation === "deadline" ? "deadline_exceeded" : "request_cancelled",
        retryable: false
      }
    }
  });
  expect.soft(after.state.blocks[identity.ref]).toEqual(before.state.blocks[identity.ref]);
  expect
    .soft(fixture.state.canvasRuntime.lease(fixture.lease.runtimeLeaseId))
    .toEqual(fixture.lease);
  expect.soft(fixture.state.canvasRuntime.activeLeases(scope)).toEqual([fixture.lease]);
  expect.soft(after.resetReceipt).toEqual(before.resetReceipt);
  expect.soft(after.results["preserved-history.txt"]).toBe(before.results["preserved-history.txt"]);
  if (invalidation === "disconnect") {
    expect.soft(fixture.response(first.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "request_cancelled", retryable: false } }
    });
    expect.soft(after).toEqual(before);
  } else {
    expect
      .soft(fixture.response(first.requestId))
      .toMatchObject({ response: { outcome: "success", operation: "complete" } });
    expect.soft(after.state.blocks[fixture.firstIdentity.ref]?.status).toBe("completed");
  }
  if (operation === "complete") expect(fixture.artifactTransfer.download).toHaveBeenCalledOnce();
  if (operation === "acquire") expect(fixture.contentTransfer.fetch).not.toHaveBeenCalled();
  if (operation === "reset")
    expect(fixture.state.canvasRuntime.resetStatus(scope, "operation-reset")).toMatchObject({
      kind: "failed",
      error: { code: "deadline_exceeded" }
    });
  const following = fixture.command(
    {
      operation: "status",
      runtimeLeaseId: fixture.lease.runtimeLeaseId
    },
    "request-after-denial"
  );
  fixture.receive(following);
  await fixture.service.handle(following);
  expect(fixture.response(following.requestId)).toMatchObject({
    response: { outcome: "success", operation: "status" }
  });
}

describe("Canvas Runtime command admission", () => {
  it.each(
    requestFailures
  )("rejects %s queued claim while its lease remains valid", async (kind) => {
    await queuedScenario("claim", kind);
  });
  it.each(queuedOperations)("guards the distinct %s queued submission path", async (operation) => {
    await queuedScenario(operation, operation === "acquire" ? "cancel" : "deadline");
  });
});
