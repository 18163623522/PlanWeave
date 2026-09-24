import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initWorkspace } from "@planweave-ai/runtime";
import { assertSmokeProcess } from "./smokeProcessGate.js";
import { startCollaborationSmokeFixture } from "./collaboration-smoke-fixture.js";

const mainEntry = resolve(process.cwd(), "dist", "main", "main.js");
const electronBin = resolve(process.cwd(), "node_modules", ".bin", "electron");
const repoRoot = resolve(process.cwd(), "../..");
const usePackagedApp = process.env.PLANWEAVE_DESKTOP_SMOKE_PACKAGED === "1";
const localCollaborationOnly = process.argv.includes("--local-collaboration");

async function resolvePackagedExecutable(): Promise<string> {
  const releaseDir = resolve(process.cwd(), "release");
  const expectedDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
  const entries = await readdir(releaseDir, { withFileTypes: true });
  if (!entries.some((entry) => entry.isDirectory() && entry.name === expectedDirectory)) {
    throw new Error(`Current packaged desktop app is missing ${expectedDirectory}.`);
  }
  return resolve(releaseDir, expectedDirectory, "PlanWeave.app", "Contents", "MacOS", "PlanWeave");
}

async function packageCurrentDesktopApp(
  onOutput: (text: string, stream: "stdout" | "stderr") => void
): Promise<void> {
  const child = spawn("pnpm", ["pack:mac"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk: Buffer) => onOutput(chunk.toString(), "stdout"));
  child.stderr.on("data", (chunk: Buffer) => onOutput(chunk.toString(), "stderr"));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Current desktop packaging failed with code ${String(code)}.`));
    });
  });
}

const smokeHome = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-home-"));
const smokeUserData = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-user-data-"));
const smokeProjectRoot = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-project-"));
process.env.PLANWEAVE_HOME = smokeHome;
const init = await initWorkspace({ projectRoot: smokeProjectRoot });

await cp(
  resolve(repoRoot, "examples", "basic-plan-package", "package"),
  init.workspace.packageDir,
  {
    recursive: true,
    force: true
  }
);
await writeFile(init.workspace.projectPromptFile, "Desktop smoke project prompt.\n", "utf8");

const collaborationFixture = localCollaborationOnly
  ? null
  : await startCollaborationSmokeFixture({
      projectRoot: smokeProjectRoot,
      projectId: init.workspace.id
    });
const switchedServerFixture = localCollaborationOnly
  ? null
  : await startCollaborationSmokeFixture({
      projectRoot: smokeProjectRoot,
      projectId: init.workspace.id
    });

let output = "";
const appendOutput = (text: string, stream: "stdout" | "stderr") => {
  output += text;
  if (stream === "stdout") process.stdout.write(text);
  else process.stderr.write(text);
};

if (usePackagedApp && localCollaborationOnly) {
  await packageCurrentDesktopApp(appendOutput);
}

const smokeCommand = usePackagedApp ? await resolvePackagedExecutable() : electronBin;
const smokeArgs = usePackagedApp ? [] : [mainEntry];

try {
  const child = spawn(smokeCommand, smokeArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLANWEAVE_HOME: smokeHome,
      PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT: smokeProjectRoot,
      PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH: join(
        init.workspace.packageDir,
        "nodes",
        "T-001",
        "prompt.md"
      ),
      PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
      PLANWEAVE_DESKTOP_SMOKE: "1",
      ...(localCollaborationOnly
        ? {
            PLANWEAVE_DESKTOP_SMOKE_LOCAL_COLLABORATION: "1",
            PLANWEAVE_DESKTOP_SMOKE_AUTHORITY_PROJECT_ID: init.workspace.id
          }
        : {
            PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL: collaborationFixture.origin,
            PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_PROJECT_ID: collaborationFixture.projectId,
            PLANWEAVE_DESKTOP_SMOKE_OPERATOR_TOKEN: collaborationFixture.operatorToken,
            PLANWEAVE_DESKTOP_SMOKE_SWITCHED_SERVER_URL: switchedServerFixture.origin,
            PLANWEAVE_DESKTOP_SMOKE_CONTROL_URL: collaborationFixture.controlOrigin,
            PLANWEAVE_DESKTOP_SMOKE_CONTROL_KEY: collaborationFixture.controlKey
          })
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  child.stdout.on("data", (chunk: Buffer) => {
    appendOutput(chunk.toString(), "stdout");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    appendOutput(chunk.toString(), "stderr");
  });

  await assertSmokeProcess(child, () => output, {
    timeoutMs: 90_000,
    terminationGraceMs: 2_000
  });
  if (output.includes("pw_operator_")) {
    throw new Error("Desktop smoke output leaked an operator token.");
  }
  if (
    localCollaborationOnly &&
    (output.includes(smokeProjectRoot) || output.includes("projectRoot"))
  ) {
    throw new Error("Local collaboration smoke output leaked a project root.");
  }
} finally {
  await collaborationFixture?.close();
  await switchedServerFixture?.close();
}
