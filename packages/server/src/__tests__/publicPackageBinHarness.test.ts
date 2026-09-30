import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIsolatedPublicPackageBins } from "./support/publicPackageBinHarness.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const directories = new Set<string>();
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.kill("SIGKILL");
      await closed;
    })
  );
  vi.mocked(spawn).mockRestore();
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true }))
  );
  directories.clear();
});

async function fixture(failServer: boolean) {
  let notifyCompilersStarted!: () => void;
  const compilersStarted = new Promise<void>((resolveStarted) => {
    notifyCompilersStarted = resolveStarted;
  });
  const repositoryRoot = await mkdtemp(join(tmpdir(), "planweave-build-lifecycle-"));
  directories.add(repositoryRoot);
  await writeFile(join(repositoryRoot, "tsconfig.json"), "{}");
  const packages = await Promise.all(
    ["server", "agent-host"].map(async (name) => {
      const packageRoot = join(repositoryRoot, "packages", name);
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await mkdir(join(packageRoot, "node_modules"));
      await writeFile(join(packageRoot, "src", "bin.ts"), "export {};");
      await writeFile(join(packageRoot, "tsconfig.json"), "{}");
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ bin: { [name]: "dist/bin.js" } })
      );
      return { packageRoot, binName: name };
    })
  );
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((executable, args, options) => {
    const configPath = String(args?.[2]);
    directories.add(resolve(dirname(configPath), "../.."));
    const code = `
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.dirname(process.argv[1]);
      if (${failServer} && path.basename(root) === 'server') {
        setTimeout(() => { console.error('compiler_failure'); process.exit(1); }, 100);
      } else {
        setTimeout(() => {
          fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
          fs.writeFileSync(path.join(root, 'dist/bin.js'), 'compiled');
        }, 600);
      }
    `;
    const child = original.spawn(executable, ["-e", code, configPath], options);
    children.push(child);
    if (children.length === 2) notifyCompilersStarted();
    return child;
  });
  return { repositoryRoot, packages, compilersStarted };
}

async function expectSetupCleaned() {
  expect(children).toHaveLength(2);
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
    true
  );
  const { access } = await import("node:fs/promises");
  for (const directory of directories) {
    if (directory.includes("planweave-public-bins-")) {
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }
}

describe("isolated public bin build lifecycle", () => {
  it("stops compilers and removes the isolated directory before reporting a setup timeout", async () => {
    const { repositoryRoot, packages, compilersStarted } = await fixture(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const build = buildIsolatedPublicPackageBins(repositoryRoot, packages, { timeoutMs: 200 });
    const rejected = expect(build).rejects.toThrow("isolated_public_bin_setup_timeout");
    await compilersStarted;
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    await expectSetupCleaned();
  });

  it("stops a sibling compiler before removing the directory when one compiler fails", async () => {
    const { repositoryRoot, packages } = await fixture(true);
    await expect(buildIsolatedPublicPackageBins(repositoryRoot, packages)).rejects.toThrow(
      "public_bin_build_failed"
    );
    await expectSetupCleaned();
  });
});
