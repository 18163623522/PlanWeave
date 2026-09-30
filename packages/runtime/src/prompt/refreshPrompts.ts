import { loadPackage } from "../package/loadPackage.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { createPromptRenderContext } from "../taskManager/promptRenderContext.js";
import { renderPromptSurfaceFromContext } from "../taskManager/promptRenderer.js";
import type { PackageWorkspaceRef, RefreshPromptsResult } from "../types.js";

export async function refreshPrompts(options: {
  projectRoot: PackageWorkspaceRef;
}): Promise<RefreshPromptsResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const graph = compileTaskGraph(manifest);
  if (graph.blockRefsInManifestOrder.length === 0) {
    return { prompts: [] };
  }
  const context = await createPromptRenderContext(options);
  const prompts = [];
  for (const ref of context.runtime.graph.blockRefsInManifestOrder) {
    prompts.push({
      ref,
      path: "",
      markdown: (await renderPromptSurfaceFromContext(context, ref)).markdown
    });
  }
  return { prompts };
}
