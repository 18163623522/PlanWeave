import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initManagedWorkspace,
  type PackageFileEntry,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { exportCanvasPackage, importPackageFiles } from "../toolPackageFiles.js";

const packageFiles: PackageFileEntry[] = [
  {
    path: "manifest.json",
    content: JSON.stringify({
      version: "plan-package/v1",
      project: { title: "Imported", description: "" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
      executors: {},
      nodes: [],
      edges: []
    }),
    encoding: "utf8" as const
  },
  { path: "nodes/T-001/prompt.md", content: "# Task\n", encoding: "utf8" as const }
];

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.PLANWEAVE_HOME;
  home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
  process.env.PLANWEAVE_HOME = home;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.PLANWEAVE_HOME;
  } else {
    process.env.PLANWEAVE_HOME = originalHome;
  }
});

async function diskSnapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        entries[relativePath] = "directory";
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        entries[relativePath] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } else {
        throw new Error(`Unexpected snapshot entry: ${path}`);
      }
    }
  }
  await visit(root, "");
  return entries;
}

async function importTempDirectories(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("planweave-mcp-import-"))
    .sort();
}

function taskPackageFiles(prompt = "nodes/T-001/prompt.md"): PackageFileEntry[] {
  const manifest: PlanPackageManifest = JSON.parse(packageFiles[0].content);
  manifest.nodes = [
    {
      id: "T-001",
      type: "task",
      title: "Task",
      prompt,
      acceptance: ["Implementation completes"],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: "Implement",
          prompt: "nodes/T-001/blocks/B-001.md",
          depends_on: []
        }
      ]
    }
  ];
  return [
    { path: "manifest.json", content: JSON.stringify(manifest), encoding: "utf8" },
    { path: "nodes/T-001/blocks/B-001.md", content: "# Implement\n", encoding: "utf8" }
  ];
}

describe("toolPackageFiles", () => {
  it("rejects imported package paths that escape the package root", async () => {
    await expect(
      importPackageFiles(
        "Bad Import",
        [{ path: "../manifest.json", content: "{}", encoding: "utf8" }],
        false
      )
    ).rejects.toThrow("Invalid package file path");
  });

  it("imports package files into the managed project's canonical default canvas", async () => {
    const unrelated = await initManagedWorkspace({ name: "Unrelated" });
    const unrelatedBefore = await diskSnapshot(unrelated.workspace.workspaceRoot);
    const registeredBefore = await readdir(join(home, "projects"));
    const tempBefore = await importTempDirectories();

    const result = await importPackageFiles("Canonical Import", packageFiles, false);

    expect(result.validation.ok).toBe(true);
    expect(result.importedFiles).toBe(packageFiles.length);
    await expect(
      readFile(
        join(result.project.rootPath, "canvases", "default", "package", "manifest.json"),
        "utf8"
      )
    ).resolves.toBe(packageFiles[0].content);
    await expect(
      readFile(
        join(
          result.project.rootPath,
          "canvases",
          "default",
          "package",
          "nodes",
          "T-001",
          "prompt.md"
        ),
        "utf8"
      )
    ).resolves.toBe("# Task\n");
    await expect(access(join(result.project.rootPath, "package"))).rejects.toThrow();
    expect((await readdir(join(home, "projects"))).sort()).toEqual(
      [...registeredBefore, result.project.projectId].sort()
    );
    expect(await diskSnapshot(unrelated.workspace.workspaceRoot)).toEqual(unrelatedBefore);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });

  it("exports the canonical default canvas package when canvasId is omitted", async () => {
    const imported = await importPackageFiles("Canonical Export", packageFiles, false);
    const legacyRootPackageDir = join(imported.project.rootPath, "package");
    await mkdir(legacyRootPackageDir, { recursive: true });
    await writeFile(join(legacyRootPackageDir, "manifest.json"), '{"legacy":true}', "utf8");

    const exported = await exportCanvasPackage(imported.project.projectId);

    expect(exported.canvasId).toBe("default");
    expect(exported.files).toEqual(packageFiles);
  });

  it.each([
    {
      name: "invalid manifest",
      files: [{ path: "manifest.json", content: "{}", encoding: "utf8" as const }],
      code: "manifest_schema"
    },
    { name: "missing prompt", files: taskPackageFiles(), code: "prompt_missing" },
    {
      name: "escaping prompt",
      files: taskPackageFiles("../outside.md"),
      code: "package_path_outside"
    }
  ])("rejects $name without changing home or leaving temporary resources", async ({
    files,
    code
  }) => {
    await initManagedWorkspace({ name: "Unrelated" });
    const before = await diskSnapshot(home);
    const tempBefore = await importTempDirectories();

    await expect(importPackageFiles("Invalid Import", files, false)).rejects.toThrow(code);

    expect(await diskSnapshot(home)).toEqual(before);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });

  it("rejects duplicate names without changing registered data", async () => {
    await initManagedWorkspace({ name: "Unrelated" });
    await importPackageFiles("Existing Import", packageFiles, false);
    const before = await diskSnapshot(home);
    const tempBefore = await importTempDirectories();

    await expect(importPackageFiles("Existing Import", packageFiles, false)).rejects.toThrow(
      "Imported project already exists. Pass overwrite: true"
    );

    expect(await diskSnapshot(home)).toEqual(before);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });

  it("overwrites only the selected package and does not follow its existing symlinks", async () => {
    const unrelated = await initManagedWorkspace({ name: "Unrelated" });
    const target = await initManagedWorkspace({ name: "Existing Import" });
    const outside = join(unrelated.workspace.workspaceRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "prompt.md"), "outside unchanged\n");
    await symlink(outside, join(target.workspace.packageDir, "linked"), "dir");
    const unrelatedBefore = await diskSnapshot(unrelated.workspace.workspaceRoot);
    const registeredBefore = (await readdir(join(home, "projects"))).sort();
    const stateBefore = await readFile(target.workspace.stateFile, "utf8");
    const metadataBefore = await readFile(target.workspace.projectFile, "utf8");
    const tempBefore = await importTempDirectories();
    const replacement = [
      ...packageFiles,
      { path: "linked/prompt.md", content: "replacement\n", encoding: "utf8" as const }
    ];

    const imported = await importPackageFiles("Existing Import", replacement, true);

    expect(imported.validation.ok).toBe(true);
    expect(await readFile(join(target.workspace.packageDir, "linked/prompt.md"), "utf8")).toBe(
      "replacement\n"
    );
    expect(await readFile(target.workspace.stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(target.workspace.projectFile, "utf8")).toBe(metadataBefore);
    expect(await diskSnapshot(unrelated.workspace.workspaceRoot)).toEqual(unrelatedBefore);
    expect((await readdir(join(home, "projects"))).sort()).toEqual(registeredBefore);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });
});
