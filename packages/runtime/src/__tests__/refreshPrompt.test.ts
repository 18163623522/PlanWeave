import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import { createExecutionGraphSession, enqueuePackageFileChanges } from "../graph/session.js";
import { writeJsonFile } from "../json.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import { renderPromptSurface } from "../taskManager/promptRenderer.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("refreshPrompt", () => {
  it("keeps a changed session Prompt version usable for disk graph commands with omitted defaults", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    expect(Object.hasOwn(manifest, "executors")).toBe(false);
    const { init } = await createTestWorkspace(manifest);
    const projectRoot = init.workspace;
    const session = await createExecutionGraphSession(projectRoot);
    manifest.nodes[0].blocks[0].title = "Updated implementation title";
    await writeJsonFile(projectRoot.manifestFile, manifest);
    enqueuePackageFileChanges(session, [{ path: "manifest.json", type: "changed" }]);

    const surface = await renderPromptSurface({ projectRoot, ref: "T-001#B-001", session });
    const batch = await refreshPrompts({ projectRoot });
    const sessionVersion = surface.markdown.match(/PlanGraph version: (\S+)/)?.[1];
    const diskVersion = batch.prompts[0]?.markdown.match(/PlanGraph version: (\S+)/)?.[1];
    expect(sessionVersion).toBeTruthy();
    expect(diskVersion).toBeTruthy();
    expect.soft(sessionVersion).toBe(diskVersion);
    expect(surface.markdown).toContain("Updated implementation title");

    const result = await executePlanGraphCommand({
      projectRoot,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: { title: manifest.nodes[0].title },
        baseGraphVersion: sessionVersion
      },
      recordOperation: false
    });
    expect(result).toMatchObject({ ok: true, changedPaths: [], diagnostics: [] });
  });

  it.each([
    { input: "{invalid JSON", error: { name: "SyntaxError" } },
    { input: JSON.stringify({ ...basicManifest(), executors: [] }), error: { name: "ZodError" } }
  ])("rejects an invalid changed session manifest with $error.name", async ({ input, error }) => {
    const { init } = await createTestWorkspace();
    const projectRoot = init.workspace;
    const session = await createExecutionGraphSession(projectRoot);
    const previousSnapshot = session.fileSnapshot;
    await writeFile(projectRoot.manifestFile, input);
    enqueuePackageFileChanges(session, [{ path: "manifest.json", type: "changed" }]);

    await expect(
      renderPromptSurface({ projectRoot, ref: "T-001#B-001", session })
    ).rejects.toMatchObject(error);
    expect(session.fileSnapshot).toBe(previousSnapshot);
  });

  it("renders block prompt surfaces without writing managed sections into source files", async () => {
    const { root, init } = await createTestWorkspace();
    const sourcePaths = [
      init.workspace.manifestFile,
      init.workspace.stateFile,
      join(init.workspace.packageDir, "nodes/T-001/prompt.md"),
      join(init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      join(init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md")
    ];
    const before = await Promise.all(sourcePaths.map((path) => readFile(path, "utf8")));

    const one = await refreshPrompt({ projectRoot: root, ref: "T-001#B-001" });
    const all = await refreshPrompts({ projectRoot: root });

    expect(one.ref).toBe("T-001#B-001");
    expect(one.markdown).toContain("planweave submit-result --canvas default T-001#B-001 --report");
    expect(all.prompts.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(all.prompts.map((prompt) => prompt.path)).toEqual(["", ""]);
    expect(all.prompts[0]?.markdown).toBe(one.markdown);
    for (const prompt of all.prompts) {
      expect(prompt.markdown).toContain("# T-001 task prompt");
      expect(prompt.markdown).toContain("- Implementation is complete.");
    }
    expect(all.prompts[0]?.markdown).toContain("# T-001#B-001 implementation prompt");
    expect(all.prompts[1]?.markdown).toContain("# T-001#R-001 review prompt");
    expect(all.prompts[1]?.markdown).toContain("## Required Review Result JSON");
    await expect(Promise.all(sourcePaths.map((path) => readFile(path, "utf8")))).resolves.toEqual(
      before
    );
  });
});
