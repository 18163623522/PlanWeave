import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type PublicPackageSpec = {
  packageRoot: string;
  binName: string;
};

export type IsolatedPublicPackageBins = {
  root: string;
  binPaths: Readonly<Record<string, string>>;
};

type PublicBinExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type RunningPublicBin = {
  child: ChildProcessWithoutNullStreams;
  result: Promise<PublicBinExit>;
  logs: { stdout: string; stderr: string };
  command: string;
  stopPromise?: Promise<void>;
};

function publicBinFailure(running: RunningPublicBin, exit: PublicBinExit): Error {
  return new Error(
    [
      `public_bin_failed:${running.command}:exit=${String(exit.code)}:signal=${String(exit.signal)}`,
      exit.error ? `error:${exit.error.message}` : "",
      `stdout:\n${running.logs.stdout}`,
      `stderr:\n${running.logs.stderr}`
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function signalPosixProcessGroup(running: RunningPublicBin, signal: NodeJS.Signals): void {
  const pid = running.child.pid;
  if (!pid) {
    throw new Error(`public_bin_pid_missing:${running.command}`);
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isPosixProcessGroupAlive(running: RunningPublicBin): boolean {
  const pid = running.child.pid;
  if (!pid) throw new Error(`public_bin_pid_missing:${running.command}`);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForPosixProcessGroupExit(
  running: RunningPublicBin,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPosixProcessGroupAlive(running)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function runWindowsTaskkill(running: RunningPublicBin, force: boolean): Promise<void> {
  const pid = running.child.pid;
  if (!pid) return Promise.reject(new Error(`public_bin_pid_missing:${running.command}`));
  return new Promise((resolveSignal, rejectSignal) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("error", rejectSignal);
    killer.once("close", (code) => {
      if (code === 0 || running.child.exitCode !== null) resolveSignal();
      else rejectSignal(new Error(`public_bin_taskkill_failed:${running.command}:exit=${code}`));
    });
  });
}

async function waitForExit(
  result: Promise<PublicBinExit>,
  timeoutMs: number
): Promise<PublicBinExit | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class PublicBinProcessRegistry {
  readonly #running = new Set<RunningPublicBin>();
  readonly #gracefulTimeoutMs: number;
  readonly #forceTimeoutMs: number;

  constructor(options: { gracefulTimeoutMs?: number; forceTimeoutMs?: number } = {}) {
    this.#gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
    this.#forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  }

  start(binPath: string, argv: readonly string[]): RunningPublicBin {
    const child = spawn(process.execPath, [binPath, ...argv], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolveResult!: (exit: PublicBinExit) => void;
    const result = new Promise<PublicBinExit>((resolve) => {
      resolveResult = resolve;
    });
    const running: RunningPublicBin = {
      child,
      result,
      logs: { stdout: "", stderr: "" },
      command: [process.execPath, binPath, ...argv].join(" ")
    };
    this.#running.add(running);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      running.logs.stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      running.logs.stderr += chunk;
    });
    child.once("error", (error) => resolveResult({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveResult({ code, signal }));
    return running;
  }

  stop(running: RunningPublicBin): Promise<void> {
    running.stopPromise ??= this.#stop(running).catch((error: unknown) => {
      running.stopPromise = undefined;
      throw error;
    });
    return running.stopPromise;
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#running].map((running) => this.stop(running))
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "public_bin_cleanup_failed");
    }
  }

  async #stop(running: RunningPublicBin): Promise<void> {
    let exit: PublicBinExit | undefined;
    let treeGone = false;
    try {
      exit = await waitForExit(running.result, 0);
      if (process.platform === "win32") {
        await runWindowsTaskkill(running, false);
        await delay(this.#gracefulTimeoutMs);
        await runWindowsTaskkill(running, true);
        exit ??= await waitForExit(running.result, this.#forceTimeoutMs);
        treeGone = true;
      } else {
        if (isPosixProcessGroupAlive(running)) {
          signalPosixProcessGroup(running, "SIGTERM");
        }
        treeGone = await waitForPosixProcessGroupExit(running, this.#gracefulTimeoutMs);
        if (!treeGone) {
          signalPosixProcessGroup(running, "SIGKILL");
          treeGone = await waitForPosixProcessGroupExit(running, this.#forceTimeoutMs);
        }
        if (!treeGone) {
          throw new Error(`public_bin_process_tree_did_not_exit:${running.command}`);
        }
        exit ??= await waitForExit(running.result, this.#forceTimeoutMs);
      }
      if (!exit) {
        throw new Error(
          `public_bin_did_not_exit:${running.command}\nstdout:\n${running.logs.stdout}\nstderr:\n${running.logs.stderr}`
        );
      }
      if (exit.error || (exit.code !== 0 && exit.signal === null)) {
        throw publicBinFailure(running, exit);
      }
    } catch (error) {
      throw new Error(
        [
          `public_bin_cleanup_failed:${running.command}`,
          `cause:${error instanceof Error ? error.message : String(error)}`,
          `stdout:\n${running.logs.stdout}`,
          `stderr:\n${running.logs.stderr}`
        ].join("\n"),
        { cause: error }
      );
    } finally {
      if (exit && treeGone) this.#running.delete(running);
    }
  }
}

function resolvePublicPackageBin(packageRoot: string, binName: string): string {
  const packageJsonPath = join(packageRoot, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relativeBinPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!relativeBinPath) {
    throw new Error(`public_bin_field_missing:${binName}`);
  }
  const absoluteBinPath = resolve(packageRoot, relativeBinPath);
  const relativeToPackage = relative(packageRoot, absoluteBinPath);
  if (relativeToPackage === ".." || relativeToPackage.startsWith(`..${sep}`)) {
    throw new Error(`public_bin_outside_package:${binName}`);
  }
  return absoluteBinPath;
}

export const PUBLIC_BIN_SETUP_TIMEOUT_MS = 60_000;

async function setupStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    console.info(
      "PUBLIC_BIN_SETUP_STAGE",
      JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - startedAt) })
    );
  }
}

async function runTypeScriptBuild(tsconfigPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const compilerPath = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [compilerPath, "-p", tsconfigPath], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL"
    });
    let spawnError: Error | undefined;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Wait for close, including on abort, before allowing the caller to remove output files.
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (signal.aborted) {
        rejectBuild(signal.reason);
        return;
      }
      if (spawnError) {
        rejectBuild(spawnError);
        return;
      }
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(
        new Error(
          `public_bin_build_failed:${tsconfigPath}:exit=${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });
  });
}

/**
 * Builds package public bins from copied source in package roots that begin without dist.
 * Only tracked source inputs are selected; workspace build output is neither read nor modified.
 */
export async function buildIsolatedPublicPackageBins(
  repositoryRoot: string,
  packages: readonly PublicPackageSpec[],
  { timeoutMs = PUBLIC_BIN_SETUP_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<IsolatedPublicPackageBins> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("invalid_public_bin_setup_timeout");
  const root = await mkdtemp(join(tmpdir(), "planweave-public-bins-"));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`isolated_public_bin_setup_timeout:${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    await writeFile(
      join(root, "tsconfig.json"),
      await readFile(join(repositoryRoot, "tsconfig.json"))
    );

    const stagedResults = await setupStage("copy", () =>
      Promise.allSettled(
        packages.map(async ({ packageRoot, binName }) => {
          controller.signal.throwIfAborted();
          const packageRelativePath = relative(repositoryRoot, packageRoot);
          const stagedPackageRoot = join(root, packageRelativePath);
          await mkdir(stagedPackageRoot, { recursive: true });
          await cp(join(packageRoot, "src"), join(stagedPackageRoot, "src"), { recursive: true });
          await cp(join(packageRoot, "package.json"), join(stagedPackageRoot, "package.json"));
          await cp(join(packageRoot, "tsconfig.json"), join(stagedPackageRoot, "tsconfig.json"));
          controller.signal.throwIfAborted();
          await symlink(
            join(packageRoot, "node_modules"),
            join(stagedPackageRoot, "node_modules"),
            "dir"
          );
          const binPath = resolvePublicPackageBin(stagedPackageRoot, binName);
          if (existsSync(binPath)) {
            throw new Error(`isolated_public_bin_not_clean:${binName}:${binPath}`);
          }
          return { binName, stagedPackageRoot, binPath };
        })
      )
    );
    const stagedPackages = stagedResults.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    await setupStage("compile", () =>
      Promise.allSettled(
        stagedPackages.map(async ({ stagedPackageRoot }) => {
          try {
            await runTypeScriptBuild(join(stagedPackageRoot, "tsconfig.json"), controller.signal);
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        })
      )
    );
    controller.signal.throwIfAborted();

    const binPaths = Object.fromEntries(
      stagedPackages.map(({ binName, binPath }) => {
        if (!existsSync(binPath)) {
          throw new Error(`isolated_public_bin_missing_after_build:${binName}:${binPath}`);
        }
        return [binName, binPath];
      })
    );
    return { root, binPaths };
  } catch (error) {
    try {
      await setupStage("cleanup", () => rm(root, { recursive: true, force: true }));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "isolated_public_bin_setup_cleanup_failed");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
