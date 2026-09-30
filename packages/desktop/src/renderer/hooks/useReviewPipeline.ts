import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type {
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopReviewPipelineStepInput
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { runLocalOnlyWhenOffline } from "../collaboration/packageWriteAdapter";
import type { createTranslator } from "../i18n";
import { normalizeNonNegativeInteger, normalizeReviewPipelineDraft } from "./reviewPipelineDraft";
import {
  acknowledgeReviewPipelineSave,
  adoptReviewPipeline,
  emptyReviewPipelineDraft,
  refreshReviewPipelineDraft,
  reviewPipelineFingerprint,
  reviewPipelineHasConflict,
  type ReviewPipelineDraftState
} from "./reviewPipelineDraftState";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

type UseReviewPipelineArgs = {
  graph: DesktopGraphViewModel | null;
  projectLoading?: boolean;
  reloadCurrentCanvas: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
  /**
   * Review pipeline has no canvas command intent yet.
   * While shared is enabled, refuse local package writes (fail closed).
   */
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
};

function missingReviewTaskError(caught: unknown, taskId: string): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.includes(`Task '${taskId}' does not exist.`);
}

function transientManifestReplacementGap(caught: unknown): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.includes("ENOENT") && /(?:^|[\\/])manifest\.json(?:'|$)/.test(message);
}

const transientManifestRetryDelayMs = 50;

export function useReviewPipeline({
  graph,
  projectLoading = false,
  reloadCurrentCanvas,
  selectedCanvasId,
  selectedProject,
  setError,
  t,
  workspaceCanvas = null
}: UseReviewPipelineArgs) {
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const scope =
    selectedProject && reviewTaskId
      ? JSON.stringify([selectedProject.rootPath, selectedCanvasId, reviewTaskId])
      : null;
  const scopeRef = useRef(scope);
  const scopeEpochRef = useRef(0);
  if (scopeRef.current !== scope) scopeEpochRef.current += 1;
  scopeRef.current = scope;
  const scopeEpoch = scopeEpochRef.current;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [draftState, setDraftState] = useState(() => emptyReviewPipelineDraft(scope));
  const draftRef = useRef(draftState);
  const updateDraftState = useCallback(
    (update: (current: ReviewPipelineDraftState) => ReviewPipelineDraftState) => {
      const next = update(draftRef.current);
      if (next !== draftRef.current) {
        draftRef.current = next;
        setDraftState(next);
      }
    },
    []
  );
  const authorityRequestRef = useRef(0);
  const activeDraft = draftState.scope === scope ? draftState : emptyReviewPipelineDraft(scope);
  const reviewPipeline = activeDraft.latest;
  const reviewDraft = activeDraft.steps;
  const reviewDefaultCyclesDraft = activeDraft.defaultCycles;
  const reviewConflict = reviewPipelineHasConflict(activeDraft);
  const reviewSaving = activeDraft.saving;

  useEffect(() => {
    updateDraftState((current) =>
      current.scope === scope ? current : emptyReviewPipelineDraft(scope)
    );
  }, [scope, updateDraftState]);

  useEffect(() => {
    if (!graph) {
      if (!projectLoading) setReviewTaskId(null);
      return;
    }
    const graphTaskIds = new Set(graph.tasks.map((task) => task.taskId));
    setReviewTaskId((current) =>
      current && graphTaskIds.has(current) ? current : (graph.tasks[0]?.taskId ?? null)
    );
  }, [graph, projectLoading]);

  useEffect(() => {
    if (
      !bridge ||
      projectLoading ||
      !selectedProject ||
      !reviewTaskId ||
      !graph?.tasks.some((task) => task.taskId === reviewTaskId)
    ) {
      if (!projectLoading) updateDraftState(() => emptyReviewPipelineDraft(scope));
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const runtimeBridge = bridge;
    const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
    const load = (retried: boolean) => {
      const request = ++authorityRequestRef.current;
      void runtimeBridge
        .getReviewPipeline(canvas, reviewTaskId)
        .then((pipeline) => {
          if (
            cancelled ||
            scopeEpochRef.current !== scopeEpoch ||
            scopeRef.current !== scope ||
            request !== authorityRequestRef.current
          )
            return;
          updateDraftState((current) =>
            current.saving
              ? { ...current, latest: pipeline }
              : refreshReviewPipelineDraft(current, pipeline)
          );
        })
        .catch((caught: unknown) => {
          if (
            cancelled ||
            scopeEpochRef.current !== scopeEpoch ||
            scopeRef.current !== scope ||
            request !== authorityRequestRef.current
          )
            return;
          if (!retried && transientManifestReplacementGap(caught)) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cancelled) load(true);
            }, transientManifestRetryDelayMs);
            return;
          }
          if (missingReviewTaskError(caught, reviewTaskId)) {
            setReviewTaskId((current) => (current === reviewTaskId ? null : current));
            updateDraftState(() => emptyReviewPipelineDraft(null));
            return;
          }
          setError(caught instanceof Error ? caught.message : String(caught));
        });
    };
    load(false);
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    graph,
    projectLoading,
    reviewTaskId,
    selectedCanvasId,
    selectedProject,
    setError,
    scope,
    scopeEpoch,
    updateDraftState
  ]);

  const clearReviewTaskSelection = useCallback(
    (taskId?: string | null) => {
      setReviewTaskId((current) => (taskId && current !== taskId ? current : null));
      if (!taskId || reviewTaskId === taskId) {
        updateDraftState(() => emptyReviewPipelineDraft(null));
      }
    },
    [reviewTaskId, updateDraftState]
  );

  const setReviewDraft = useCallback(
    (update: (current: DesktopReviewPipelineStepInput[]) => DesktopReviewPipelineStepInput[]) => {
      updateDraftState((current) => {
        const steps = update(current.steps);
        let nextStepKey = current.nextStepKey;
        const stepKeys = steps.map((step) => {
          const previousIndex = current.steps.indexOf(step);
          return previousIndex >= 0 ? current.stepKeys[previousIndex] : nextStepKey++;
        });
        return { ...current, steps, stepKeys, nextStepKey, revision: current.revision + 1 };
      });
    },
    [updateDraftState]
  );

  const setReviewDefaultCyclesDraft = useCallback(
    (value: SetStateAction<number>) => {
      updateDraftState((current) => ({
        ...current,
        defaultCycles: typeof value === "function" ? value(current.defaultCycles) : value,
        revision: current.revision + 1
      }));
    },
    [updateDraftState]
  );

  const reloadReviewPipelineDraft = useCallback(() => {
    updateDraftState((current) =>
      current.latest && !current.saving
        ? adoptReviewPipeline({ ...current, revision: current.revision + 1 }, current.latest)
        : current
    );
  }, [updateDraftState]);

  const updateReviewStep = useCallback(
    (index: number, patch: Partial<DesktopReviewPipelineStepInput>) => {
      updateDraftState((current) => ({
        ...current,
        steps: current.steps.map((step, stepIndex) =>
          stepIndex === index ? { ...step, ...patch } : step
        ),
        revision: current.revision + 1
      }));
    },
    [updateDraftState]
  );

  const addReviewStep = useCallback(() => {
    setReviewDraft((current) => [
      ...current,
      {
        blockId: "",
        title: t("defaultReviewStepTitle"),
        enabled: true,
        preset: t("defaultReviewStepPreset"),
        triggerCondition: "after_required_work_completed",
        inputContext: t("defaultReviewInputContext"),
        passCriteria: t("defaultReviewPassCriteria"),
        feedbackFormat: t("defaultReviewFeedbackFormat"),
        maxFeedbackCycles: reviewPipeline?.packageDefaults.maxFeedbackCycles ?? 1,
        hook: null,
        promptMarkdown: t("defaultReviewPrompt")
      }
    ]);
  }, [reviewPipeline, t, setReviewDraft]);

  const moveReviewStep = useCallback(
    (index: number, direction: -1 | 1) => {
      setReviewDraft((current) => {
        const target = index + direction;
        if (target < 0 || target >= current.length) {
          return current;
        }
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    [setReviewDraft]
  );

  const removeReviewStep = useCallback(
    (index: number) => {
      setReviewDraft((current) => current.filter((_, stepIndex) => stepIndex !== index));
    },
    [setReviewDraft]
  );

  const saveReviewPipeline = useCallback(async () => {
    const sent = draftRef.current;
    const base = sent.base;
    if (
      !bridge ||
      !selectedProject ||
      !reviewTaskId ||
      projectLoading ||
      !base ||
      sent.scope !== scope ||
      sent.saving
    )
      return;
    const isCurrent = () =>
      mountedRef.current &&
      scopeEpochRef.current === scopeEpoch &&
      scopeRef.current === scope &&
      draftRef.current.scope === scope;
    const scopedError = (message: string | null) => {
      if (isCurrent()) setError(message);
    };
    if (reviewPipelineHasConflict(sent)) {
      scopedError(t("reviewPipelineConflict"));
      return;
    }
    const runtimeBridge = bridge;
    const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
    updateDraftState((current) => ({ ...current, saving: true }));
    ++authorityRequestRef.current;
    const submittedDefaultCycles = normalizeNonNegativeInteger(sent.defaultCycles);
    const submittedInput = normalizeReviewPipelineDraft({
      packageDefaults: { maxFeedbackCycles: submittedDefaultCycles, completionPolicy: "strict" },
      steps: sent.steps
    });
    try {
      const mode = await runLocalOnlyWhenOffline({
        workspaceCanvas,
        onError: scopedError,
        unsupportedMessage: t("canvasCommandUnsupportedLocalOnly"),
        localWrite: async () => {
          const latest = await runtimeBridge.getReviewPipeline(canvas, reviewTaskId);
          if (!isCurrent()) return;
          if (
            reviewPipelineFingerprint(latest.steps, latest.packageDefaults.maxFeedbackCycles) !==
            reviewPipelineFingerprint(base.steps, base.packageDefaults.maxFeedbackCycles)
          ) {
            updateDraftState((current) => ({ ...current, latest }));
            throw new Error(t("reviewPipelineConflict"));
          }
          const result = await runtimeBridge.updateReviewPipeline(
            canvas,
            reviewTaskId,
            submittedInput
          );
          if (!result.ok)
            throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        }
      });
      if (mode !== "local" || !isCurrent()) return;
      ++authorityRequestRef.current;
      const pipeline = await runtimeBridge.getReviewPipeline(canvas, reviewTaskId);
      if (!isCurrent()) return;
      updateDraftState((current) =>
        acknowledgeReviewPipelineSave(
          current,
          sent,
          pipeline,
          submittedInput.steps,
          submittedDefaultCycles
        )
      );
      await reloadCurrentCanvas();
    } catch (caught: unknown) {
      scopedError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent()) updateDraftState((current) => ({ ...current, saving: false }));
    }
  }, [
    projectLoading,
    reloadCurrentCanvas,
    reviewTaskId,
    scope,
    scopeEpoch,
    selectedCanvasId,
    selectedProject,
    setError,
    workspaceCanvas,
    t,
    updateDraftState
  ]);

  return {
    addReviewStep,
    clearReviewTaskSelection,
    moveReviewStep,
    removeReviewStep,
    reloadReviewPipelineDraft,
    reviewConflict,
    reviewSaving,
    reviewDefaultCyclesDraft,
    reviewDraft,
    reviewPipeline,
    reviewTaskId,
    saveReviewPipeline,
    setReviewDefaultCyclesDraft,
    setReviewTaskId,
    updateReviewStep
  };
}
