/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopBridgeApi,
  DesktopGraphViewModel,
  DesktopReviewPipeline
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project } from "./helpers/desktopProjectFixtures";
import { graph, reviewPipeline } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const initialPipeline: DesktopReviewPipeline = {
  ...reviewPipeline,
  steps: [
    reviewPipeline.steps[0],
    {
      ...reviewPipeline.steps[0],
      blockId: "R-002",
      blockRef: "T-ALPHA#R-002",
      title: "Second review"
    }
  ]
};

async function setup() {
  const getReviewPipeline = vi
    .fn<DesktopBridgeApi["getReviewPipeline"]>()
    .mockResolvedValue(initialPipeline);
  const updateReviewPipeline = vi
    .fn<DesktopBridgeApi["updateReviewPipeline"]>()
    .mockResolvedValue({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
  const bridge = createDesktopBridgeMock({ getReviewPipeline, updateReviewPipeline });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
    import("../renderer/hooks/useReviewPipeline"),
    import("../renderer/i18n")
  ]);
  const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
  const setError = vi.fn();
  const t = createTranslator("en");
  const hook = renderHook(
    ({
      graphValue,
      canvasId,
      loading
    }: {
      graphValue: DesktopGraphViewModel | null;
      canvasId: string;
      loading: boolean;
    }) =>
      useReviewPipeline({
        graph: graphValue,
        selectedCanvasId: canvasId,
        selectedProject: project,
        projectLoading: loading,
        reloadCurrentCanvas,
        setError,
        t
      }),
    { initialProps: { graphValue: graph, canvasId: "canvas-main", loading: false } }
  );
  await waitFor(() => expect(hook.result.current.reviewPipeline).toEqual(initialPipeline));
  return { ...hook, getReviewPipeline, updateReviewPipeline, reloadCurrentCanvas, setError };
}

describe("Review Pipeline local drafts", () => {
  it("keeps edited steps, order and default cycles across same-version and runtime-only graph refreshes", async () => {
    const { result, rerender, getReviewPipeline } = await setup();
    act(() => {
      result.current.updateReviewStep(0, { title: "Local title" });
      result.current.moveReviewStep(0, 1);
      result.current.setReviewDefaultCyclesDraft(7);
    });
    const expectedSteps = [
      initialPipeline.steps[1],
      { ...initialPipeline.steps[0], title: "Local title" }
    ];
    for (const nextGraph of [
      { ...graph },
      {
        ...graph,
        graphVersion: "runtime-refresh",
        tasks: graph.tasks.map((task) => ({ ...task, status: "in_progress" as const }))
      }
    ]) {
      const previousCalls = getReviewPipeline.mock.calls.length;
      rerender({ graphValue: nextGraph, canvasId: "canvas-main", loading: false });
      await waitFor(() =>
        expect(getReviewPipeline.mock.calls.length).toBeGreaterThan(previousCalls)
      );
      await act(async () => undefined);
      expect(result.current.reviewDraft).toEqual(expectedSteps);
      expect(result.current.reviewDefaultCyclesDraft).toBe(7);
    }
  });
  it("updates clean forms from new authority", async () => {
    const { result, rerender, getReviewPipeline } = await setup();
    const latest: DesktopReviewPipeline = {
      ...initialPipeline,
      packageDefaults: { maxFeedbackCycles: 4, completionPolicy: "strict" },
      steps: [...initialPipeline.steps].reverse()
    };
    getReviewPipeline.mockResolvedValue(latest);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    await waitFor(() => expect(result.current.reviewDraft).toEqual(latest.steps));
    expect(result.current.reviewDefaultCyclesDraft).toBe(4);
    expect(result.current.reviewConflict).toBe(false);
  });

  it("preserves a dirty form through external changes and further edits until explicit reload", async () => {
    const { result, rerender, getReviewPipeline, updateReviewPipeline } = await setup();
    act(() => result.current.updateReviewStep(0, { title: "Local title" }));
    const latest: DesktopReviewPipeline = {
      ...initialPipeline,
      packageDefaults: { maxFeedbackCycles: 3, completionPolicy: "strict" },
      steps: [{ ...initialPipeline.steps[0], title: "External title" }, initialPipeline.steps[1]]
    };
    getReviewPipeline.mockResolvedValue(latest);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    await waitFor(() => expect(result.current.reviewConflict).toBe(true));
    expect(result.current.reviewDraft[0].title).toBe("Local title");
    act(() => result.current.setReviewDefaultCyclesDraft(8));
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    expect(updateReviewPipeline).not.toHaveBeenCalled();
    expect(result.current.reviewConflict).toBe(true);
    act(() => result.current.reloadReviewPipelineDraft());
    expect(result.current.reviewDraft).toEqual(latest.steps);
    expect(result.current.reviewDefaultCyclesDraft).toBe(3);
    expect(result.current.reviewConflict).toBe(false);
  });

  it.each([
    ["enabled", { enabled: false }],
    ["preset", { preset: "security" }],
    ["trigger", { triggerCondition: "manual" }],
    ["context", { inputContext: "External context" }],
    ["pass criteria", { passCriteria: "External criteria" }],
    ["feedback", { feedbackFormat: "External feedback" }],
    ["step cycles", { maxFeedbackCycles: 9 }],
    ["prompt", { promptMarkdown: "# External review" }],
    [
      "hook",
      {
        hook: {
          id: "external-hook",
          type: "executable",
          command: "node",
          args: ["review"],
          executionPolicy: "trusted-local"
        }
      }
    ]
  ] as const)("detects an external change to %s", async (_field, patch) => {
    const { result, rerender, getReviewPipeline } = await setup();
    act(() => result.current.updateReviewStep(0, { title: "Local title" }));
    const latest: DesktopReviewPipeline = {
      ...initialPipeline,
      steps: [
        {
          ...initialPipeline.steps[0],
          ...patch,
          hook: "hook" in patch ? { ...patch.hook, args: [...patch.hook.args] } : null
        },
        initialPipeline.steps[1]
      ]
    };
    getReviewPipeline.mockResolvedValue(latest);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    await waitFor(() => expect(result.current.reviewConflict).toBe(true));
    expect(result.current.reviewDraft[0].title).toBe("Local title");
  });

  it("checks the latest authority before writing even when graph refresh has not observed it", async () => {
    const { result, getReviewPipeline, updateReviewPipeline, setError } = await setup();
    act(() => result.current.updateReviewStep(0, { title: "Local title" }));
    getReviewPipeline.mockResolvedValue({
      ...initialPipeline,
      steps: [...initialPipeline.steps].reverse()
    });
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    expect(updateReviewPipeline).not.toHaveBeenCalled();
    expect(result.current.reviewConflict).toBe(true);
    expect(result.current.reviewDraft[0].title).toBe("Local title");
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("changed outside"));
  });

  it("keeps drafts and reports a failed save", async () => {
    const { result, updateReviewPipeline, setError } = await setup();
    act(() => {
      result.current.updateReviewStep(0, { title: "Local title" });
      result.current.setReviewDefaultCyclesDraft(7);
    });
    updateReviewPipeline.mockRejectedValue(new Error("write failed"));
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    expect(result.current.reviewDraft[0].title).toBe("Local title");
    expect(result.current.reviewDefaultCyclesDraft).toBe(7);
    expect(result.current.reviewSaving).toBe(false);
    expect(setError).toHaveBeenCalledWith("write failed");
  });

  it("retains an observed external conflict when a pending save fails", async () => {
    const { result, rerender, getReviewPipeline, updateReviewPipeline } = await setup();
    const save = deferred<Awaited<ReturnType<DesktopBridgeApi["updateReviewPipeline"]>>>();
    updateReviewPipeline.mockReturnValue(save.promise);
    act(() => result.current.updateReviewStep(0, { title: "Local title" }));
    let pending: Promise<void>;
    act(() => {
      pending = result.current.saveReviewPipeline();
    });
    await waitFor(() => expect(updateReviewPipeline).toHaveBeenCalledTimes(1));
    const latest = {
      ...initialPipeline,
      steps: [{ ...initialPipeline.steps[0], title: "External title" }, initialPipeline.steps[1]]
    };
    getReviewPipeline.mockResolvedValue(latest);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    await waitFor(() => expect(result.current.reviewConflict).toBe(true));
    await act(async () => {
      save.reject(new Error("write failed"));
      await pending;
    });
    expect(result.current.reviewDraft[0].title).toBe("Local title");
    expect(result.current.reviewConflict).toBe(true);
    expect(result.current.reviewSaving).toBe(false);
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    expect(updateReviewPipeline).toHaveBeenCalledTimes(1);
  });

  it("keeps the submitted base separate from an external version observed by the post-write read", async () => {
    const { result, getReviewPipeline, updateReviewPipeline } = await setup();
    const save = deferred<Awaited<ReturnType<DesktopBridgeApi["updateReviewPipeline"]>>>();
    const read = deferred<DesktopReviewPipeline>();
    updateReviewPipeline.mockReturnValue(save.promise);
    act(() => result.current.updateReviewStep(0, { title: "Submitted title" }));
    let pending: Promise<void>;
    act(() => {
      pending = result.current.saveReviewPipeline();
    });
    await waitFor(() => expect(updateReviewPipeline).toHaveBeenCalledTimes(1));
    getReviewPipeline.mockReturnValueOnce(read.promise);
    await act(async () => {
      save.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
    });
    await waitFor(() => expect(getReviewPipeline).toHaveBeenCalledTimes(3));
    act(() => {
      result.current.updateReviewStep(0, { title: "Later local title" });
      result.current.setReviewDefaultCyclesDraft(8);
    });
    const external: DesktopReviewPipeline = {
      ...initialPipeline,
      steps: [
        { ...initialPipeline.steps[0], title: "Another writer title" },
        initialPipeline.steps[1]
      ]
    };
    await act(async () => {
      read.resolve(external);
      await pending;
    });
    expect(result.current.reviewDraft[0].title).toBe("Later local title");
    expect(result.current.reviewDefaultCyclesDraft).toBe(8);
    expect(result.current.reviewConflict).toBe(true);
    getReviewPipeline.mockResolvedValue(external);
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    expect(updateReviewPipeline).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only the submitted revision while later edits stay dirty across refresh", async () => {
    const { result, rerender, getReviewPipeline, updateReviewPipeline } = await setup();
    const save = deferred<Awaited<ReturnType<DesktopBridgeApi["updateReviewPipeline"]>>>();
    updateReviewPipeline.mockReturnValue(save.promise);
    act(() => {
      result.current.updateReviewStep(0, { title: "Submitted title" });
      result.current.setReviewDefaultCyclesDraft(7);
    });
    let pending: Promise<void>;
    act(() => {
      pending = result.current.saveReviewPipeline();
    });
    await waitFor(() => expect(updateReviewPipeline).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.updateReviewStep(0, { title: "Later title" });
      result.current.moveReviewStep(0, 1);
      result.current.setReviewDefaultCyclesDraft(8);
    });
    const saved: DesktopReviewPipeline = {
      ...initialPipeline,
      packageDefaults: { maxFeedbackCycles: 7, completionPolicy: "strict" },
      steps: [{ ...initialPipeline.steps[0], title: "Submitted title" }, initialPipeline.steps[1]]
    };
    getReviewPipeline.mockResolvedValue(saved);
    await act(async () => {
      save.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
      await pending;
    });
    const expected = [
      initialPipeline.steps[1],
      { ...initialPipeline.steps[0], title: "Later title" }
    ];
    expect(result.current.reviewDraft).toEqual(expected);
    expect(result.current.reviewDefaultCyclesDraft).toBe(8);
    expect(result.current.reviewConflict).toBe(false);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    await act(async () => undefined);
    expect(result.current.reviewDraft).toEqual(expected);
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("ignores a previous canvas save %s with the same task id", async (outcome) => {
    const {
      result,
      rerender,
      getReviewPipeline,
      updateReviewPipeline,
      setError,
      reloadCurrentCanvas
    } = await setup();
    const save = deferred<Awaited<ReturnType<DesktopBridgeApi["updateReviewPipeline"]>>>();
    updateReviewPipeline.mockReturnValue(save.promise);
    act(() => result.current.updateReviewStep(0, { title: "Old canvas edit" }));
    let pending: Promise<void>;
    act(() => {
      pending = result.current.saveReviewPipeline();
    });
    await waitFor(() => expect(updateReviewPipeline).toHaveBeenCalledTimes(1));
    const next: DesktopReviewPipeline = {
      ...initialPipeline,
      packageDefaults: { maxFeedbackCycles: 2, completionPolicy: "strict" },
      steps: [{ ...initialPipeline.steps[0], title: "Next canvas" }]
    };
    getReviewPipeline.mockResolvedValue(next);
    rerender({ graphValue: graph, canvasId: "canvas-next", loading: false });
    await waitFor(() => expect(result.current.reviewDraft).toEqual(next.steps));
    await act(async () => {
      if (outcome === "resolve")
        save.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
      else save.reject(new Error("old write failed"));
      await pending;
    });
    expect(result.current.reviewDraft).toEqual(next.steps);
    expect(result.current.reviewDefaultCyclesDraft).toBe(2);
    expect(setError).not.toHaveBeenCalled();
    expect(reloadCurrentCanvas).not.toHaveBeenCalled();
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("ignores a previous canvas read %s with the same task id", async (outcome) => {
    const { result, rerender, getReviewPipeline, setError } = await setup();
    const read = deferred<DesktopReviewPipeline>();
    getReviewPipeline.mockReturnValueOnce(read.promise);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    const next: DesktopReviewPipeline = {
      ...initialPipeline,
      steps: [{ ...initialPipeline.steps[0], title: "Next canvas" }]
    };
    getReviewPipeline.mockResolvedValue(next);
    rerender({ graphValue: graph, canvasId: "canvas-next", loading: false });
    await waitFor(() => expect(result.current.reviewDraft).toEqual(next.steps));
    await act(async () => {
      if (outcome === "resolve") read.resolve(initialPipeline);
      else read.reject(new Error("old read failed"));
    });
    expect(result.current.reviewDraft).toEqual(next.steps);
    expect(setError).not.toHaveBeenCalled();
  });

  it("preserves edits during same-scope project loading and transient manifest retry", async () => {
    const { result, rerender, getReviewPipeline, setError } = await setup();
    act(() => result.current.updateReviewStep(0, { title: "Local title" }));
    rerender({ graphValue: null, canvasId: "canvas-main", loading: true });
    expect(result.current.reviewDraft[0].title).toBe("Local title");
    getReviewPipeline
      .mockRejectedValueOnce(new Error("ENOENT: open '/test/package/manifest.json'"))
      .mockResolvedValue(initialPipeline);
    rerender({ graphValue: { ...graph }, canvasId: "canvas-main", loading: false });
    await waitFor(() => expect(getReviewPipeline).toHaveBeenCalledTimes(3));
    expect(result.current.reviewDraft[0].title).toBe("Local title");
    expect(result.current.reviewConflict).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("clears dirty data after the selected task is deleted", async () => {
    const { result, rerender, getReviewPipeline } = await setup();
    act(() => result.current.updateReviewStep(0, { title: "Deleted task edit" }));
    const next = { ...initialPipeline, taskId: "T-BETA", steps: [] };
    getReviewPipeline.mockResolvedValue(next);
    rerender({
      graphValue: { ...graph, tasks: [graph.tasks[1]] },
      canvasId: "canvas-main",
      loading: false
    });
    await waitFor(() => expect(result.current.reviewTaskId).toBe("T-BETA"));
    await waitFor(() => expect(result.current.reviewPipeline).toEqual(next));
    expect(result.current.reviewDraft).toEqual([]);
    expect(result.current.reviewConflict).toBe(false);
  });

  it("acknowledges normalized fields, generated blank prompts and authoritative new ids", async () => {
    const { result, getReviewPipeline, updateReviewPipeline } = await setup();
    const save = deferred<Awaited<ReturnType<DesktopBridgeApi["updateReviewPipeline"]>>>();
    updateReviewPipeline.mockReturnValueOnce(save.promise);
    act(() => {
      result.current.updateReviewStep(0, {
        title: "  Saved title  ",
        preset: "  security  ",
        inputContext: "  saved context  ",
        passCriteria: "  saved criteria  ",
        feedbackFormat: "  saved feedback  ",
        promptMarkdown: "  ",
        maxFeedbackCycles: 2.9
      });
      result.current.setReviewDefaultCyclesDraft(3.9);
      result.current.addReviewStep();
      result.current.updateReviewStep(2, { title: "  New saved title  ", promptMarkdown: "" });
    });
    let pending: Promise<void>;
    act(() => {
      pending = result.current.saveReviewPipeline();
    });
    await waitFor(() => expect(updateReviewPipeline).toHaveBeenCalledTimes(1));
    const added = updateReviewPipeline.mock.calls[0][2].steps[2];
    const saved: DesktopReviewPipeline = {
      ...initialPipeline,
      packageDefaults: { maxFeedbackCycles: 3, completionPolicy: "strict" },
      steps: [
        {
          ...initialPipeline.steps[0],
          title: "Saved title",
          preset: "security",
          inputContext: "saved context",
          passCriteria: "saved criteria",
          feedbackFormat: "saved feedback",
          maxFeedbackCycles: 2,
          promptMarkdown:
            "# Saved title\n\nReview the completed work and return passed or needs_changes feedback.\n"
        },
        initialPipeline.steps[1],
        {
          ...added,
          title: "New saved title",
          blockId: "R-008",
          blockRef: "T-ALPHA#R-008",
          promptMarkdown:
            "# New saved title\n\nReview the completed work and return passed or needs_changes feedback.\n"
        }
      ]
    };
    getReviewPipeline.mockResolvedValue(saved);
    await act(async () => {
      save.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
      await pending;
    });
    expect(result.current.reviewDraft).toEqual(saved.steps);
    expect(result.current.reviewDefaultCyclesDraft).toBe(3);
    expect(result.current.reviewConflict).toBe(false);
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    expect(updateReviewPipeline).toHaveBeenCalledTimes(2);
    expect(updateReviewPipeline.mock.calls[1][2].steps[2].blockId).toBe("R-008");
    expect(result.current.reviewConflict).toBe(false);
  });

  it("fills saved ids into submitted new steps without consuming newer additions, edits or order", async () => {
    const { result, getReviewPipeline, updateReviewPipeline } = await setup();
    const save = deferred<Awaited<ReturnType<DesktopBridgeApi["updateReviewPipeline"]>>>();
    updateReviewPipeline.mockReturnValueOnce(save.promise);
    act(() => {
      result.current.addReviewStep();
      result.current.updateReviewStep(2, { title: "Submitted new step" });
    });
    const sentNewStep = result.current.reviewDraft[2];
    let pending: Promise<void>;
    act(() => {
      pending = result.current.saveReviewPipeline();
    });
    await waitFor(() => expect(updateReviewPipeline).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.updateReviewStep(2, { title: "Later new-step edit" });
      result.current.moveReviewStep(2, -1);
      result.current.addReviewStep();
    });
    const saved: DesktopReviewPipeline = {
      ...initialPipeline,
      steps: [
        ...initialPipeline.steps,
        { ...sentNewStep, blockId: "R-003", blockRef: "T-ALPHA#R-003" }
      ]
    };
    getReviewPipeline.mockResolvedValue(saved);
    await act(async () => {
      save.resolve({ ok: true, affectedTasks: ["T-ALPHA"], diagnostics: [] });
      await pending;
    });
    expect(result.current.reviewDraft.map((step) => [step.blockId, step.title])).toEqual([
      ["B-001", "Review implementation"],
      ["R-003", "Later new-step edit"],
      ["R-002", "Second review"],
      ["", "New review step"]
    ]);
    await act(async () => {
      await result.current.saveReviewPipeline();
    });
    const secondInput = updateReviewPipeline.mock.calls[1][2];
    expect(secondInput.steps[1].blockId).toBe("R-003");
    expect(secondInput.steps[3].blockId).toBe("");
  });
});
