import { chmod, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimNext,
  getAutoRunStatus,
  getExecutionStatus,
  initManagedWorkspace,
  linkProjectSourceRoot,
  trustCommand
} from "../index.js";
import { optionalReadFile } from "../fs/optionalFile.js";
import { ExecutorCancelledError, prepareBlockRun } from "../autoRun/executorShared.js";
import { readState } from "../state.js";
import * as json from "../json.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createContractCodexExecAdapter, runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run codex executor", () => {
  it.each([
    { batch: false, outcome: "prepare" },
    { batch: true, outcome: "prepare" },
    { batch: false, outcome: "failure" },
    { batch: true, outcome: "failure" },
    { batch: false, outcome: "cancel" },
    { batch: true, outcome: "cancel" }
  ])("preserves a completed owner after a late duplicate $outcome (batch=$batch)", async ({
    batch,
    outcome
  }) => {
    const manifest = manifestTestBuilder({ parallel: true, maxConcurrent: 2 })
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => console.log('done'));"]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const adapter = createContractCodexExecAdapter({
      projectRoot: root,
      executorName: "fake-codex"
    });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const metadataPath = join(runRoot, "RUN-001", "metadata.json");
    const reportPath = join(runRoot, "RUN-001", "report.md");
    let completedState: Awaited<ReturnType<typeof readState>> | undefined;
    let metadata: string | undefined;
    let report: string | undefined;
    const delayedError =
      outcome === "cancel"
        ? new ExecutorCancelledError("late duplicate cancelled")
        : new Error("late duplicate failed");
    const duplicate = await runContractAutoRunStep({
      projectRoot: root,
      parallel: batch,
      executor: {
        async runBlock(input) {
          const owner = await runContractAutoRunStep({ projectRoot: root, executor: adapter });
          expect(owner).toMatchObject({ kind: "submitted", submitResult: { runId: "RUN-001" } });
          completedState = await readState(init.workspace.stateFile);
          expect(completedState.blocks["T-001#B-001"]).toMatchObject({
            status: "completed",
            lastRunId: "RUN-001",
            submissionAttemptId: input.claim.submissionAttemptId
          });
          expect(completedState.blocks["T-001#R-001"].status).toBe("ready");
          metadata = await readFile(metadataPath, "utf8");
          report = await readFile(reportPath, "utf8");
          if (outcome !== "prepare") throw delayedError;
          return adapter.runBlock(input);
        },
        async runFeedback() {
          throw new Error("unexpected feedback");
        }
      }
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    expect((await readState(init.workspace.stateFile)).blocks["T-001#B-001"].status).toBe(
      "completed"
    );
    expect(await readState(init.workspace.stateFile)).toEqual(completedState);
    expect(await readFile(metadataPath, "utf8")).toBe(metadata);
    expect(await readFile(reportPath, "utf8")).toBe(report);
    expect(report).toContain("done");
    expect((await readdir(runRoot)).filter((name) => !name.startsWith("."))).toEqual(["RUN-001"]);
    expect(duplicate.value).toBeUndefined();
    const error =
      batch && duplicate.error instanceof AggregateError
        ? duplicate.error.errors[0]
        : duplicate.error;
    if (outcome === "prepare")
      expect(error).toMatchObject({ message: expect.stringContaining("attempt conflicts") });
    else expect(error).toBe(delayedError);
  });

  it.each([
    false,
    true
  ])("rejects duplicate automatic execution without releasing its owner (batch=%s)", async (batch) => {
    const code = `const fs=require('node:fs'); process.stdin.resume(); process.stdin.on('end',()=>{fs.appendFileSync('started.txt',process.pid+'\\n'); const t=setInterval(()=>{if(fs.existsSync('release.txt')){clearInterval(t); console.log('report pid='+process.pid);}},10);});`;
    const manifest = manifestTestBuilder({ parallel: true, maxConcurrent: 2 })
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", code]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const adapter = createContractCodexExecAdapter({
      projectRoot: root,
      executorName: "fake-codex"
    });
    const start = () => runContractAutoRunStep({ projectRoot: root, executor: adapter });
    const started = async () =>
      (await optionalReadFile(join(root, "started.txt"), "utf8"))
        ?.trim()
        .split("\n")
        .filter(Boolean) ?? [];
    const waitForOwner = async () => {
      for (let i = 0; i < 200; i++) {
        if ((await started()).length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("process barrier timeout");
    };
    let owner: ReturnType<typeof start> | undefined;
    let before: Awaited<ReturnType<typeof readState>> | undefined;
    let denied: Promise<void> | undefined;
    let denial: unknown;
    let settled = false;
    try {
      let duplicate: ReturnType<typeof start>;
      if (batch) {
        duplicate = runContractAutoRunStep({
          projectRoot: root,
          parallel: true,
          executor: {
            async runBlock(input) {
              owner = start();
              await waitForOwner();
              before = await readState(init.workspace.stateFile);
              return adapter.runBlock(input);
            },
            async runFeedback() {
              throw new Error("unexpected feedback");
            }
          }
        });
      } else {
        owner = start();
        await waitForOwner();
        before = await readState(init.workspace.stateFile);
        duplicate = start();
      }
      denied = duplicate.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          denial = error;
          settled = true;
        }
      );
      for (let i = 0; i < 200; i++) {
        if (settled || (await started()).length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await started()).toHaveLength(1);
      expect(denial).toBeInstanceOf(Error);
      expect((denial as Error).message).toContain("already admitted");
      expect(await readState(init.workspace.stateFile)).toEqual(before);
      const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
      expect((await readdir(runRoot)).filter((name) => !name.startsWith("."))).toEqual(["RUN-001"]);
    } finally {
      await writeFile(join(root, "release.txt"), "release");
      await denied;
      if (owner)
        expect(await owner).toMatchObject({
          kind: "submitted",
          submitResult: { runId: "RUN-001" }
        });
    }
  });

  it("retries a proven pending automatic admission after metadata write failure and rejects unknown legacy admission", async () => {
    const { root, init } = await createTestWorkspace();
    const claim = await claimNext({ projectRoot: root });
    if (claim.kind !== "block") throw new Error("expected block");
    const options = {
      projectRoot: root,
      claim,
      executorName: "fake-codex",
      adapter: "codex-exec" as const,
      profile: { adapter: "codex-exec" as const, command: process.execPath, args: [] },
      prompt: "prompt"
    };
    const failure = Object.assign(new Error("admission ENOSPC"), { code: "ENOSPC" });
    const originalWrite = json.writeJsonFile;
    const spy = vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value) => {
      if (
        path.endsWith("metadata.json") &&
        typeof (value as Record<string, unknown>).executionAdmittedAt === "string"
      )
        throw failure;
      return originalWrite(path, value);
    });
    try {
      await expect(prepareBlockRun(options)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const metadataPath = join(runRoot, "RUN-001", "metadata.json");
    expect(await readJsonFile(metadataPath)).toMatchObject({ executionAdmittedAt: null });
    expect((await prepareBlockRun(options)).runId).toBe("RUN-001");
    const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
    expect(metadata.executionAdmittedAt).toEqual(expect.any(String));
    delete metadata.executionAdmittedAt;
    await writeJsonFile(metadataPath, metadata);
    const original = await readFile(metadataPath, "utf8");
    await expect(prepareBlockRun(options)).rejects.toThrow("already admitted");
    expect(await readFile(metadataPath, "utf8")).toBe(original);
    expect((await readdir(runRoot)).filter((name) => !name.startsWith("."))).toEqual(["RUN-001"]);
  });

  it("persists the scheduler wave id in every CLI run created by one parallel batch", async () => {
    const manifest = manifestTestBuilder({
      parallel: true,
      maxConcurrent: 2,
      includeSecondTask: true
    })
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => console.log('done'));"]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    await expect(
      runContractAutoRunStep({
        projectRoot: root,
        parallel: true,
        executor: createContractCodexExecAdapter({
          projectRoot: root,
          executorName: "fake-codex"
        })
      })
    ).resolves.toMatchObject({ kind: "batch_submitted" });
    const metadata = await Promise.all(
      ["T-001", "T-002"].map((taskId) =>
        readJsonFile<Record<string, unknown>>(
          join(
            init.workspace.resultsDir,
            taskId,
            "blocks",
            "B-001",
            "runs",
            "RUN-001",
            "metadata.json"
          )
        )
      )
    );

    expect(metadata[0]?.executionWaveId).toMatch(/^WAVE-[0-9a-f-]{36}$/);
    expect(metadata[1]?.executionWaveId).toBe(metadata[0]?.executionWaveId);
  });

  it("codex-exec adapter runs the configured command and submits the generated block report", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            "  fs.writeFileSync(path.join(process.cwd(), 'executor-cwd.txt'), process.cwd());",
            "  console.error('memory says thread_id=019e4ab3-ddfe-7c20-a2e0-86919e1a62ab but this is not a Codex resume session');",
            "  console.error('│  Session:                     019e52a6-030c-71c1-9146-712651be1d65                      │');",
            "  console.log('report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "block", reportPath: expect.stringContaining("report.md") },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });
    await expect(
      readFile(
        join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stdout.md"),
        "utf8"
      )
    ).resolves.toContain("report:true");
    await expect(readFile(join(root, "executor-cwd.txt"), "utf8")).resolves.toBe(
      init.workspace.rootPath
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
      executor: "fake-codex",
      adapter: "codex-exec",
      projectRoot: init.workspace.rootPath,
      executionCwd: init.workspace.rootPath,
      codexSessionId: "019e52a6-030c-71c1-9146-712651be1d65",
      agentSessionId: "019e52a6-030c-71c1-9146-712651be1d65",
      exitCode: 0
    });
  });

  it("codex-exec adapter runs managed projects in the bound source root", async () => {
    const fakeCodexArgs = [
      "-e",
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "let input='';",
        "process.stdin.on('data', c => input += c);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(path.join(process.cwd(), 'executor-cwd.txt'), process.cwd());",
        "  console.log('report:' + input.includes('Implement task'));",
        "});"
      ].join("")
    ];
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: fakeCodexArgs
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const resolvedSourceRoot = await realpath(sourceRoot);
    process.env.PLANWEAVE_HOME = home;
    const init = await initManagedWorkspace({ name: "Managed Auto Run" });
    const resolvedWorkspaceRoot = await realpath(init.workspace.rootPath);
    await linkProjectSourceRoot(init.workspace.id, sourceRoot);
    await writeJsonFile(init.workspace.manifestFile, manifest);
    await writePromptFiles(init.workspace.packageDir, manifest);
    await trustCommand(init.workspace.rootPath, process.execPath, fakeCodexArgs);

    const step = await runContractAutoRunStep({
      projectRoot: init.workspace.rootPath,
      executor: createContractCodexExecAdapter({
        projectRoot: init.workspace.rootPath,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });
    await expect(readFile(join(sourceRoot, "executor-cwd.txt"), "utf8")).resolves.toBe(
      resolvedSourceRoot
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
      projectRoot: resolvedWorkspaceRoot,
      executionCwd: resolvedSourceRoot
    });
  });

  it("blocks the current block when the configured executor exits unsuccessfully", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("failing-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); console.error('codex failed'); process.exit(7);"]
      })
      .withDefaultExecutor("failing-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "failing-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("codex failed")
      }
    });
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
      executor: "failing-codex",
      adapter: "codex-exec",
      exitCode: 7
    });
    await expect(
      readFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "stderr.log"
        ),
        "utf8"
      )
    ).resolves.toContain("codex failed");
    await expect(getExecutionStatus({ projectRoot: root })).resolves.toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          reason: expect.stringContaining("codex failed")
        })
      ])
    });
    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      explanation: {
        phase: "blocked",
        currentRef: null,
        currentExecutor: "failing-codex",
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: expect.stringContaining("metadata.json"),
        latestOutputSummary: expect.stringContaining("codex failed"),
        error: expect.stringContaining("codex failed"),
        nextAction: {
          kind: "inspect_record",
          message: "Inspect the latest run record, then resolve the blocker before retrying.",
          targetPath: expect.stringContaining("metadata.json"),
          ref: "T-001#B-001"
        }
      },
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          stderrSummary: expect.stringContaining("codex failed"),
          failureReason: expect.stringContaining("codex failed")
        })
      ]
    });
  });

  it("times out a codex-exec block run and exposes the blocked failure reason", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("slow-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('late report'), 1000);"],
        timeoutMs: 25
      })
      .withDefaultExecutor("slow-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "slow-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("timed out")
      }
    });
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
      executor: "slow-codex",
      adapter: "codex-exec",
      exitCode: 124,
      timeoutMs: 25,
      timedOut: true
    });
    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          failureReason: expect.stringContaining("timed out")
        })
      ]
    });
  });

  it("resumes a failed codex-exec block run when a session id is available", async () => {
    const { root, init } = await createTestWorkspace();
    const fakeCodex = join(root, "fake-codex.mjs");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('resume')) {",
        "  console.log('resumed report from ' + args[args.indexOf('resume') + 1]);",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session.updated', session: { id: 'SESSION-123' } }));",
        "console.error('first attempt failed');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodex, 0o755);
    const fakeCodexArgs = ["exec", "-"];
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: fakeCodex,
        args: fakeCodexArgs
      })
      .withDefaultExecutor("fake-codex")
      .build();
    await writeFile(init.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await trustCommand(root, fakeCodex, fakeCodexArgs);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex",
        runtime: { tmuxEnabled: false }
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: {
        kind: "block",
        stdout: expect.stringContaining("resumed report from SESSION-123")
      },
      submitResult: {
        ref: "T-001#B-001",
        status: "completed"
      }
    });
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "metadata.json"
      )
    );
    expect(metadata.codexSessionId).toBe("SESSION-123");
    expect(metadata.agentSessionId).toBe("SESSION-123");
    expect(metadata.resumed).toBe(true);
    await expect(
      readFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "stderr.log"
        ),
        "utf8"
      )
    ).resolves.toContain("first attempt failed");
  });

  it("codex-exec adapter stores review stdout as review-result.json for submit-review", async () => {
    const reviewJson = JSON.stringify({
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "passed by fake codex"
    });
    const manifest = manifestTestBuilder()
      .withExecutor("fake-reviewer", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(reviewJson)})`]
      })
      .withDefaultExecutor("fake-reviewer")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          const reportPath = join(root, "implementation.md");
          await writeFile(reportPath, "implemented\n", "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });
    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-reviewer"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: { kind: "review", resultPath: expect.stringContaining("review-result.json") },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "R-001",
          "runs",
          "RUN-001",
          "review-result.json"
        )
      )
    ).resolves.toMatchObject({
      verdict: "passed"
    });
  });
});
