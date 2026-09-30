import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("refreshPrompt", () => {
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
