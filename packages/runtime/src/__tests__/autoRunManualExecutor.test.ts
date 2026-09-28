import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimNext,
  runAutoRunStep,
  markBlockDiverged,
  resolveBlockDivergence,
  createManualExecutorAdapter,
  getAutoRunStatus,
  submitBlockResult,
  submitReviewResult
} from "../index.js";
import * as taskManager from "../taskManager/index.js";
import { prepareAcpBlockRun } from "../autoRun/acpRunPreparation.js";
import * as json from "../json.js";
import { readState, writeState } from "../state.js";
import { ExecutorCancelledError, prepareBlockRun } from "../autoRun/executorShared.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import {
  createFormalManualCanvasWorkspace,
  runContractAutoRunStep
} from "./autoRunTestBuilders.js";

describe("Auto Run manual executor", () => {
  it.each([
    false,
    true
  ])("starts a new manual cycle after explicit legacy recovery (dispatch=%s)", async (dispatch) => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2 })
    );
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("expected block claim");
    const state = await readState(init.workspace.stateFile);
    delete state.blocks[claim.ref].submissionAttemptId;
    await writeState(init.workspace.stateFile, state);
    const before = await readFile(init.workspace.stateFile, "utf8");
    await runAutoRunStep({ projectRoot: root, executorName: "manual" });
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(before);
    await taskManager.markBlockBlocked({
      projectRoot: root,
      ref: claim.ref,
      reason: "old executor drained"
    });
    await taskManager.unblockBlock({
      projectRoot: root,
      ref: claim.ref,
      reason: "start a new execution cycle"
    });
    const recovered = dispatch
      ? await taskManager.claimDispatchedBlock({ projectRoot: root, ref: claim.ref })
      : await claimNext({ projectRoot: root });
    if (recovered.kind !== "block") throw new Error("expected recovered claim");
    expect(recovered.submissionAttemptId).toEqual(expect.any(String));
    expect(recovered.submissionAttemptId).not.toBe(claim.submissionAttemptId);
    expect(await runAutoRunStep({ projectRoot: root, executorName: "manual" })).toMatchObject({
      kind: "manual"
    });
    expect(
      await submitBlockResult({
        projectRoot: root,
        ref: recovered.ref,
        reportPath: await writeReport(root, "recovered.md")
      })
    ).toMatchObject({ status: "completed", runId: "RUN-001" });
  });

  it("rejects repeated legacy ACP preparation before allocating any RUN", async () => {
    const { root, init } = await createTestWorkspace();
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("expected block claim");
    delete claim.submissionAttemptId;
    const state = await readState(init.workspace.stateFile);
    delete state.blocks[claim.ref].submissionAttemptId;
    await writeState(init.workspace.stateFile, state);
    const before = await readFile(init.workspace.stateFile, "utf8");
    const files = await readdir(init.workspace.resultsDir, { recursive: true });
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        prepareAcpBlockRun({
          projectRoot: root,
          claim,
          executorName: "codex-acp",
          profile: { adapter: "agent", agent: "codex", runner: { transport: "acp" } },
          prompt: "legacy implementation"
        })
      )
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    for (const outcome of outcomes) {
      if (outcome.status !== "rejected") throw new Error("expected rejected preparation");
      expect(outcome.reason).toMatchObject({
        message: expect.stringContaining("submissionAttemptId")
      });
    }
    expect(await readdir(init.workspace.resultsDir, { recursive: true })).toEqual(files);
    expect(await readFile(init.workspace.stateFile, "utf8")).toBe(before);
  });

  it.each([
    { batch: false, outcome: "result" },
    { batch: true, outcome: "result" },
    { batch: false, outcome: "failure" },
    { batch: true, outcome: "failure" },
    { batch: false, outcome: "cancelled" },
    { batch: true, outcome: "cancelled" }
  ])("rejects a captured legacy claim after reclaim before its $outcome can write back (batch=$batch)", async ({
    batch,
    outcome
  }) => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2 })
    );
    const legacy = await claimNext({ projectRoot: root });
    if (legacy.kind !== "block") throw new Error("expected implementation claim");
    delete legacy.submissionAttemptId;
    const state = await readState(init.workspace.stateFile);
    delete state.blocks[legacy.ref].submissionAttemptId;
    await writeState(init.workspace.stateFile, state);
    const originalClaimNext = taskManager.claimNext;
    let reclaimed: Awaited<ReturnType<typeof readState>> | undefined;
    let executorCalls = 0;
    const claimSpy = vi.spyOn(taskManager, "claimNext").mockImplementationOnce(async () => {
      await taskManager.releaseInProgressBlock({ projectRoot: root, ref: legacy.ref });
      await originalClaimNext({
        projectRoot: root,
        scope: { kind: "block", blockRef: legacy.ref }
      });
      reclaimed = await readState(init.workspace.stateFile);
      expect(reclaimed.blocks[legacy.ref].submissionAttemptId).toEqual(expect.any(String));
      return batch
        ? {
            kind: "batch",
            refs: [legacy.ref],
            effectiveExecutors: { [legacy.ref]: legacy.effectiveExecutor }
          }
        : legacy;
    });
    let error: unknown;
    try {
      await runAutoRunStep({
        projectRoot: root,
        parallel: batch,
        executor: {
          async runBlock() {
            executorCalls++;
            if (outcome === "failure") throw new Error("legacy executor failed");
            if (outcome === "cancelled")
              throw new ExecutorCancelledError("legacy executor cancelled");
            return { kind: "block", reportPath: await writeReport(root, "legacy-late.md") };
          },
          async runFeedback() {
            throw new Error("unexpected feedback");
          }
        }
      });
    } catch (caught) {
      error = caught;
    } finally {
      claimSpy.mockRestore();
    }
    expect(await readState(init.workspace.stateFile)).toEqual(reclaimed);
    expect(executorCalls).toBe(0);
    const rejected = error instanceof AggregateError ? error.errors[0] : error;
    expect(rejected).toMatchObject({ message: expect.stringContaining("submissionAttemptId") });
    expect(
      (await readdir(init.workspace.resultsDir, { recursive: true })).some((path) =>
        path.includes("RUN-")
      )
    ).toBe(false);
  });

  it.each([
    false,
    true
  ])("binds manual execution to its claimed attempt (parallel=%s)", async (parallel) => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2 })
    );
    const result = await runAutoRunStep({ projectRoot: root, parallel, executorName: "manual" });
    const step = result.kind === "batch_submitted" ? result.steps[0] : result;
    if (step.kind !== "manual") throw new Error("expected manual step");
    const state = await readState(init.workspace.stateFile);
    const metadata = await readJsonFile(join(step.adapterResult.runDir!, "metadata.json"));
    expect(metadata).toMatchObject({
      submissionAttemptId: state.blocks[step.claim.ref].submissionAttemptId
    });
    const submitted = await submitBlockResult({
      projectRoot: root,
      ref: step.claim.ref,
      reportPath: await writeReport(root, "manual.md")
    });
    expect(submitted.runId).toBe(step.adapterResult.runId);
  });

  it("rejects a prepared parallel result after reclaim without changing the new claim", async () => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2 })
    );
    const result = await runAutoRunStep({
      projectRoot: root,
      parallel: true,
      executorName: "manual"
    });
    if (result.kind !== "batch_submitted" || result.steps[0].kind !== "manual")
      throw new Error("expected manual batch");
    const old = result.steps[0];
    await markBlockDiverged({ projectRoot: root, ref: old.claim.ref, reason: "retry" });
    await resolveBlockDivergence({ projectRoot: root, ref: old.claim.ref, reason: "new attempt" });
    await claimNext({ projectRoot: root, scope: { kind: "block", blockRef: old.claim.ref } });
    const before = await readState(init.workspace.stateFile);
    await expect(
      submitBlockResult({
        projectRoot: root,
        ref: old.claim.ref,
        runId: old.adapterResult.runId,
        reportPath: await writeReport(root, "old.md")
      })
    ).rejects.toThrow("attempt conflicts");
    expect(await readState(init.workspace.stateFile)).toEqual(before);
  });

  it.each([
    "result",
    "failure",
    "cancelled"
  ])("keeps a reclaimed attempt unchanged when the old executor settles via %s", async (outcome) => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2 })
    );
    let reclaimedState: Awaited<ReturnType<typeof readState>> | undefined;
    const executing = runAutoRunStep({
      projectRoot: root,
      parallel: true,
      executor: {
        async runBlock({ claim }) {
          const run = await prepareBlockRun({
            projectRoot: root,
            claim,
            executorName: "manual",
            adapter: "manual",
            profile: { adapter: "manual" },
            prompt: "old execution"
          });
          await markBlockDiverged({ projectRoot: root, ref: claim.ref, reason: "interrupt" });
          await resolveBlockDivergence({ projectRoot: root, ref: claim.ref, reason: "retry" });
          await claimNext({ projectRoot: root, scope: { kind: "block", blockRef: claim.ref } });
          reclaimedState = await readState(init.workspace.stateFile);
          if (outcome === "failure") throw new Error("old executor failure");
          if (outcome === "cancelled") throw new ExecutorCancelledError("old executor cancelled");
          return {
            kind: "block" as const,
            runId: run.runId,
            reportPath: await writeReport(root, "late.md")
          };
        },
        async runFeedback() {
          throw new Error("unexpected feedback");
        }
      }
    });
    await expect(executing).rejects.toThrow(
      outcome === "result"
        ? "attempt conflicts"
        : `old executor ${outcome === "failure" ? "failure" : "cancelled"}`
    );
    expect(await readState(init.workspace.stateFile)).toEqual(reclaimedState);
  });

  it.each([
    false,
    true
  ])("reuses one manual preparation across repeated starts (concurrent=%s)", async (concurrent) => {
    const { root, init } = await createTestWorkspace();
    const start = () => runAutoRunStep({ projectRoot: root, executorName: "manual" });
    const results = concurrent
      ? await Promise.all([start(), start()])
      : [await start(), await start()];
    if (results[0].kind !== "manual" || results[1].kind !== "manual")
      throw new Error("expected manual steps");
    expect(results[1].adapterResult.runId).toBe(results[0].adapterResult.runId);
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    expect((await readdir(runRoot)).filter((name) => !name.startsWith("."))).toEqual(["RUN-001"]);
    expect(
      (
        await submitBlockResult({
          projectRoot: root,
          ref: "T-001#B-001",
          reportPath: await writeReport(root, "same.md")
        })
      ).runId
    ).toBe("RUN-001");
  });

  it("retries preparation after initial metadata ENOSPC without leaving an unidentified RUN", async () => {
    const { root, init } = await createTestWorkspace();
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("expected block");
    const options = {
      projectRoot: root,
      claim,
      executorName: "manual",
      adapter: "manual" as const,
      profile: { adapter: "manual" as const },
      prompt: "prompt"
    };
    const failure = Object.assign(new Error("prepare metadata ENOSPC"), { code: "ENOSPC" });
    const spy = vi.spyOn(json, "writeJsonFile").mockImplementationOnce(async () => {
      throw failure;
    });
    try {
      await expect(prepareBlockRun(options)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    const run = await prepareBlockRun(options);
    expect(run.runId).toBe("RUN-001");
    expect(
      (
        await submitBlockResult({
          projectRoot: root,
          ref: claim.ref,
          reportPath: await writeReport(root, "recovered.md")
        })
      ).runId
    ).toBe(run.runId);
    expect((await readState(init.workspace.stateFile)).blocks[claim.ref].status).toBe("completed");
  });

  it("manual adapter claims a block, writes the rendered prompt artifact, and waits for manual submission", async () => {
    const { root, init } = await createTestWorkspace();
    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createManualExecutorAdapter({
        projectRoot: root,
        executorName: "manual"
      })
    });

    expect(step).toMatchObject({
      kind: "manual",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "manual", executor: "manual" }
    });
    if (step.kind !== "manual") {
      throw new Error("expected manual step");
    }
    await expect(access(step.adapterResult.promptPath)).resolves.toBeUndefined();
    await expect(readFile(step.adapterResult.promptPath, "utf8")).resolves.toContain(
      "# T-001#B-001: Implement task"
    );
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "manual",
      adapter: "manual",
      exitCode: null
    });
  });

  it("exposes tmux metadata in Auto Run status latest run summaries", async () => {
    const { root, init } = await createTestWorkspace();
    await runContractAutoRunStep({
      projectRoot: root,
      executor: createManualExecutorAdapter({
        projectRoot: root,
        executorName: "manual"
      })
    });

    const metadataPath = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001",
      "metadata.json"
    );
    const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
    await writeJsonFile(metadataPath, {
      ...metadata,
      tmuxSessionName: "planweave-T-001-B-001-RUN-001-123abcd",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-123abcd",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-123abcd"
    });

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          tmuxSessionName: "planweave-T-001-B-001-RUN-001-123abcd",
          tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-123abcd",
          tmuxReadOnlyAttachCommand:
            "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-123abcd"
        })
      ]
    });
  });

  it("routes feedback through the claim effective executor instead of the manifest default", async () => {
    const manifest = manifestTestBuilder()
      .withDefaultExecutor("manual")
      .withExecutor("feedback-runner", {
        adapter: "manual"
      })
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "feedback-runner" }))
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(
        root,
        "needs_changes",
        "Fix with the implementation executor."
      )
    });

    const feedbackStep = await runContractAutoRunStep({ projectRoot: root });

    expect(feedbackStep).toMatchObject({
      kind: "manual",
      claim: { kind: "feedback", feedbackId: "FE-001", effectiveExecutor: "feedback-runner" },
      adapterResult: { executor: "feedback-runner" }
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json"))
    ).resolves.toMatchObject({
      feedbackId: "FE-001",
      executor: "feedback-runner",
      adapter: "manual"
    });
  });

  it("manual adapter scopes next commands for formal project graph canvases with arbitrary package paths", async () => {
    const { root, workspace } = await createFormalManualCanvasWorkspace();
    const executor = createManualExecutorAdapter({
      projectRoot: workspace,
      executorName: "manual"
    });

    const implementationStep = await runContractAutoRunStep({
      projectRoot: workspace,
      executor
    });

    expect(implementationStep).toMatchObject({
      kind: "manual",
      adapterResult: {
        nextCommand:
          "planweave submit-result --canvas manual-canvas T-001#B-001 --report <report.md>"
      }
    });
    await submitBlockResult({
      projectRoot: workspace,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await runContractAutoRunStep({
      projectRoot: workspace,
      executor
    });
    await submitReviewResult({
      projectRoot: workspace,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix formal canvas work.")
    });

    const feedbackStep = await runContractAutoRunStep({
      projectRoot: workspace,
      executor
    });

    expect(feedbackStep).toMatchObject({
      kind: "manual",
      adapterResult: {
        nextCommand:
          "planweave submit-feedback --canvas manual-canvas --report <feedback-report.md>"
      }
    });
    await expect(getAutoRunStatus({ projectRoot: workspace })).resolves.toMatchObject({
      current: {
        refs: [],
        feedbackId: "FE-001",
        reviewBlockRef: "T-001#R-001"
      },
      explanation: {
        phase: "manual",
        currentRef: "FE-001",
        currentExecutor: "manual",
        latestRecordId: "FE-001::RUN-001",
        latestRecordPath: expect.stringContaining(
          join("feedback-runs", "RUN-001", "metadata.json")
        ),
        latestOutputSummary:
          "planweave submit-feedback --canvas manual-canvas --report <feedback-report.md>",
        nextAction: {
          kind: "submit_manual_result",
          command: "planweave submit-feedback --canvas manual-canvas --report <feedback-report.md>",
          ref: "FE-001"
        }
      },
      latestRuns: expect.arrayContaining([
        expect.objectContaining({
          kind: "feedback",
          ref: "FE-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          runId: "RUN-001",
          executor: "manual",
          adapter: "manual",
          status: "in_progress",
          promptPath: expect.stringContaining(join("feedback-runs", "RUN-001", "feedback.md")),
          metadataPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json"))
        })
      ])
    });
  });
});
