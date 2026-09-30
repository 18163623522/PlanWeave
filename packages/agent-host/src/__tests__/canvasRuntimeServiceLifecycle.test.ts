import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { createRemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import type {
  CanvasRuntimeResolverPort,
  ResolvedCanvasRuntime
} from "../runtime/canvasRuntimeResolver.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";

import {
  directories,
  setup,
  scope,
  sourceRevision,
  graphFingerprint,
  artifactTransfer,
  contentTransfer,
  request,
  cancel,
  delivery,
  response,
  unusedWorkspace,
  resolverWith,
  createLease
} from "./support/canvasRuntimeServiceFixture.js";

describe("Canvas Runtime Host Lifecycle", () => {
  it("keeps package lease evidence separate from block mutation evidence", async () => {
    const { state } = await setup();
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
    };
    const workspace = await createTestWorkspace(manifest);
    directories.push(workspace.home, workspace.root);
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: workspace.init.workspace,
        canvas: workspace.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    createLease(state);
    const candidate = await createRemoteBlockRuntimePort({
      projectRoot: workspace.init.workspace
    }).inspect({ ref: "T-001#B-001" });
    expect(candidate.sourceRevision).not.toBe(sourceRevision);
    const claim = request("request-block-evidence", {
      operation: "claim",
      runtimeLeaseId: "runtime-lease-1",
      evidence: {
        operationId: "operation-block-evidence",
        sourceRevision: candidate.sourceRevision,
        graphFingerprint: candidate.graphFingerprint
      },
      input: {
        ref: "T-001#B-001",
        operationId: "operation-block-evidence",
        controlPlane: "collaboration",
        sourceRevision: candidate.sourceRevision,
        graphFingerprint: candidate.graphFingerprint
      }
    });
    state.receive(delivery(1, claim));
    await service.handle(claim);
    expect(response(state, claim.requestId)).toMatchObject({
      response: { outcome: "success", operation: "claim" }
    });
  });

  it("preserves an ownership operation conflict returned by the Runtime", async () => {
    const { state } = await setup();
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
    };
    const workspace = await createTestWorkspace(manifest);
    directories.push(workspace.home, workspace.root);
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: workspace.init.workspace,
        canvas: workspace.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    createLease(state);
    const candidate = await createRemoteBlockRuntimePort({
      projectRoot: workspace.init.workspace
    }).inspect({ ref: "T-001#B-001" });
    const currentIdentity = {
      ref: "T-001#B-001",
      operationId: "operation-current",
      controlPlane: "collaboration" as const,
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint
    };
    const currentEvidence = {
      operationId: currentIdentity.operationId,
      sourceRevision: currentIdentity.sourceRevision,
      graphFingerprint: currentIdentity.graphFingerprint
    };
    const claim = request("request-current-claim", {
      operation: "claim",
      runtimeLeaseId: "runtime-lease-1",
      evidence: currentEvidence,
      input: currentIdentity
    });
    const activate = request("request-current-activate", {
      operation: "activate",
      runtimeLeaseId: "runtime-lease-1",
      evidence: currentEvidence,
      input: {
        ...currentIdentity,
        dispatchId: "dispatch-current",
        executionAttemptId: "attempt-current"
      }
    });
    const failPrevious = request("request-previous-fail", {
      operation: "fail",
      runtimeLeaseId: "runtime-lease-1",
      evidence: { ...currentEvidence, operationId: "operation-previous" },
      input: {
        ...currentIdentity,
        operationId: "operation-previous",
        dispatchId: "dispatch-previous",
        executionAttemptId: "attempt-previous",
        failure: { code: "remote_test_failure", message: "Failed.", retryable: false }
      }
    });

    state.receive(delivery(1, claim));
    await service.handle(claim);
    state.receive(delivery(2, activate));
    await service.handle(activate);
    state.receive(delivery(3, failPrevious));
    await service.handle(failPrevious);

    expect(response(state, failPrevious.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "remote_ownership_operation_conflict" }
      }
    });
  });

  it("fails closed when the capability was not negotiated or the deadline elapsed", async () => {
    const { state } = await setup();
    const resolve = vi.fn<CanvasRuntimeResolverPort["resolve"]>();
    const resolver = resolverWith(resolve);
    const capabilityRequest = request("request-capability");
    state.receive(delivery(1, capabilityRequest));
    await new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [],
      artifactTransfer,
      contentTransfer
    }).handle(capabilityRequest);
    expect(response(state, "request-capability")).toMatchObject({
      response: { outcome: "error", error: { code: "capability_not_negotiated" } }
    });

    const deadlineRequest = request(
      "request-deadline",
      { operation: "availability" },
      "2020-01-01T00:00:00.000Z"
    );
    state.receive(delivery(2, deadlineRequest));
    await new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    }).handle(deadlineRequest);
    expect(response(state, "request-deadline")).toMatchObject({
      response: { outcome: "error", error: { code: "deadline_exceeded" } }
    });

    const skewedRequest = request(
      "request-clock-skew",
      { operation: "availability" },
      "2026-01-01T00:05:00.000Z"
    );
    state.receive(delivery(3, skewedRequest));
    const skewedService = new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    skewedService.synchronizeServerTime(
      "2026-01-01T00:10:00.000Z",
      new Date("2026-01-01T00:00:00.000Z")
    );
    await skewedService.handle(skewedRequest);
    expect(response(state, "request-clock-skew")).toMatchObject({
      response: { outcome: "error", error: { code: "deadline_exceeded" } }
    });
    expect(artifactTransfer.synchronizeServerTime).toHaveBeenCalledWith(
      "2026-01-01T00:10:00.000Z",
      new Date("2026-01-01T00:00:00.000Z")
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("cancels uncommitted work without rewriting Runtime state", async () => {
    const { state } = await setup();
    let releaseResolve: ((value: ResolvedCanvasRuntime) => void) | undefined;
    const blocked = new Promise<ResolvedCanvasRuntime>((resolve) => {
      releaseResolve = resolve;
    });
    let calls = 0;
    const workspace = unusedWorkspace();
    const resolver = resolverWith(async () => {
      calls += 1;
      return calls === 1 ? blocked : { scope, project: workspace, canvas: workspace };
    });
    const service = new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    const target = request("request-target");
    const cancellation = cancel("request-cancel", "request-target");
    state.receive(delivery(1, target));
    const targetRun = service.handle(target);
    await Promise.resolve();
    state.receive(delivery(2, cancellation));
    await service.handle(cancellation);
    releaseResolve?.({ scope, project: workspace, canvas: workspace });
    await targetRun;

    expect(response(state, "request-cancel")).toMatchObject({
      response: { outcome: "success", result: { cancelled: true } }
    });
    expect(response(state, "request-target")).toMatchObject({
      response: { outcome: "error", error: { code: "request_cancelled" } }
    });
  });

  it("aborts uncommitted work when the Host disconnects", async () => {
    const { state } = await setup();
    let releaseResolve: ((value: ResolvedCanvasRuntime) => void) | undefined;
    const blocked = new Promise<ResolvedCanvasRuntime>((resolve) => {
      releaseResolve = resolve;
    });
    const workspace = unusedWorkspace();
    const service = new CanvasRuntimeService({
      resolver: resolverWith(() => blocked),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    const target = request("request-disconnect");
    state.receive(delivery(1, target));
    const run = service.handle(target);
    await Promise.resolve();
    service.disconnect();
    releaseResolve?.({ scope, project: workspace, canvas: workspace });
    await run;

    expect(response(state, target.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "request_cancelled" } }
    });
  });

  it("strictly parses Runtime inputs and keeps complete fail-closed without artifact bytes", async () => {
    const { state } = await setup();
    const workspace = unusedWorkspace();
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({ scope, project: workspace, canvas: workspace })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    createLease(state);
    const inspect = request("request-invalid-inspect", {
      operation: "inspect",
      runtimeLeaseId: "runtime-lease-1",
      input: { unexpected: true }
    });
    state.receive(delivery(1, inspect));
    await service.handle(inspect);
    expect(response(state, inspect.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "invalid_operation_input" } }
    });

    const complete = request("request-complete-without-bytes", {
      operation: "complete",
      runtimeLeaseId: "runtime-lease-1",
      evidence: { operationId: "operation-1", sourceRevision, graphFingerprint },
      input: {
        ref: "T-001#B-001",
        operationId: "operation-1",
        controlPlane: "collaboration",
        sourceRevision,
        graphFingerprint,
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        reportArtifactRef: `artifact:sha256:${"c".repeat(64)}`
      }
    });
    state.receive(delivery(2, complete));
    await service.handle(complete);
    expect(response(state, complete.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "invalid_operation_input" } }
    });
  });
});
