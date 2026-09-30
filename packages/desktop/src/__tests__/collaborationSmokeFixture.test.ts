import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { startCollaborationSmokeFixture } from "../../scripts/collaboration-smoke-fixture.js";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";

it("keeps smoke control failure diagnostics local and returns a stable HTTP error", async () => {
  const workspace = await createTestWorkspace();
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let fixture: Awaited<ReturnType<typeof startCollaborationSmokeFixture>> | undefined;
  try {
    fixture = await startCollaborationSmokeFixture({
      projectRoot: workspace.root,
      projectId: workspace.init.workspace.id
    });
    const rejected = await fetch(`${fixture.controlOrigin}/seed-remote`, { method: "POST" });
    expect(rejected.status).toBe(403);
    expect(diagnostics).not.toHaveBeenCalled();

    const failed = await fetch(`${fixture.controlOrigin}/seed-remote`, {
      method: "POST",
      headers: { "x-smoke-control-key": fixture.controlKey }
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "smoke_control_request_failed" });
    expect(
      diagnostics.mock.calls.some((args) =>
        args.some(
          (value) => value instanceof Error && value.message === "smoke_owner_membership_missing"
        )
      )
    ).toBe(true);

    const healthy = await fetch(`${fixture.controlOrigin}/counts`, {
      headers: { "x-smoke-control-key": fixture.controlKey }
    });
    expect(healthy.status).toBe(200);
  } finally {
    diagnostics.mockRestore();
    await fixture?.close();
    await Promise.all(
      [workspace.root, workspace.home].map((root) => rm(root, { recursive: true, force: true }))
    );
  }
});
