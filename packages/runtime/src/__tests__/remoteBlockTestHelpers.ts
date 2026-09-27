import { createHash } from "node:crypto";
import { createRemoteBlockRuntimePort } from "../taskManager/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

export function remoteManifest(
  options: { dependency?: boolean; parallel?: boolean; upstreamTask?: boolean } = {}
): PlanPackageManifest {
  const manifest = basicManifest({
    parallel: options.parallel,
    maxConcurrent: 1,
    includeSecondTask: options.upstreamTask
  });
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  if (options.dependency) {
    const task = manifest.nodes[0];
    if (task.type !== "task") {
      throw new Error("Expected the test manifest to start with a task.");
    }
    task.blocks.splice(1, 0, {
      id: "B-002",
      type: "implementation",
      title: "Consume first implementation",
      prompt: "nodes/T-001/blocks/B-002.prompt.md",
      depends_on: ["B-001"]
    });
    const review = task.blocks.find((block) => block.id === "R-001");
    if (review) {
      review.depends_on = ["B-002"];
    }
  }
  if (options.upstreamTask) {
    manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
  }
  return manifest;
}

export function activeIdentity(candidate: { sourceRevision: string; graphFingerprint: string }) {
  return {
    operationId: "operation-001",
    controlPlane: "collaboration" as const,
    sourceRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint,
    dispatchId: "dispatch-001",
    executionAttemptId: "attempt-001"
  };
}

export function reportInput(bytes: Buffer) {
  return {
    reportArtifactRef: `artifact:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    reportBytes: bytes,
    transcript: {
      sessionId: "remote-session-001",
      executor: "codex-acp",
      agentId: "codex" as const,
      events: []
    }
  };
}

export function claimIdentity(identity: ReturnType<typeof activeIdentity>) {
  const { dispatchId: _dispatchId, executionAttemptId: _attemptId, ...claim } = identity;
  return claim;
}

export async function activateReadyBlock(manifest = remoteManifest()) {
  const workspace = await createTestWorkspace(manifest);
  const port = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
  const candidate = await port.inspect({ ref: "T-001#B-001" });
  const identity = activeIdentity(candidate);
  await port.claim({ ref: "T-001#B-001", ...claimIdentity(identity) });
  await port.activate({ ref: "T-001#B-001", ...identity });
  return { ...workspace, port, candidate, identity };
}
