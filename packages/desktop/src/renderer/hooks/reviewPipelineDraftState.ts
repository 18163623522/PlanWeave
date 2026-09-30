import type { DesktopReviewPipeline, DesktopReviewPipelineStepInput } from "@planweave-ai/runtime";
import { normalizeReviewPipelineStepContent } from "@planweave-ai/runtime/browser";

export type ReviewPipelineDraftState = {
  scope: string | null;
  base: DesktopReviewPipeline | null;
  latest: DesktopReviewPipeline | null;
  steps: DesktopReviewPipelineStepInput[];
  stepKeys: number[];
  nextStepKey: number;
  defaultCycles: number;
  revision: number;
  saving: boolean;
};

export function emptyReviewPipelineDraft(scope: string | null): ReviewPipelineDraftState {
  return {
    scope,
    base: null,
    latest: null,
    steps: [],
    stepKeys: [],
    nextStepKey: 0,
    defaultCycles: 1,
    revision: 0,
    saving: false
  };
}

export function reviewPipelineFingerprint(
  steps: DesktopReviewPipelineStepInput[],
  defaultCycles: number
): string {
  return JSON.stringify([
    defaultCycles,
    steps.map((step) => [
      step.blockId,
      step.title,
      step.enabled,
      step.preset,
      step.triggerCondition,
      step.inputContext,
      step.passCriteria,
      step.feedbackFormat,
      step.maxFeedbackCycles,
      step.hook
        ? [
            step.hook.id,
            step.hook.type,
            step.hook.command,
            step.hook.args,
            step.hook.executionPolicy
          ]
        : null,
      step.promptMarkdown
    ])
  ]);
}

export function reviewPipelineIsDirty(state: ReviewPipelineDraftState): boolean {
  return (
    state.base !== null &&
    reviewPipelineFingerprint(state.steps, state.defaultCycles) !==
      reviewPipelineFingerprint(state.base.steps, state.base.packageDefaults.maxFeedbackCycles)
  );
}

export function reviewPipelineHasConflict(state: ReviewPipelineDraftState): boolean {
  return (
    state.base !== null &&
    state.latest !== null &&
    reviewPipelineFingerprint(state.base.steps, state.base.packageDefaults.maxFeedbackCycles) !==
      reviewPipelineFingerprint(state.latest.steps, state.latest.packageDefaults.maxFeedbackCycles)
  );
}

export function adoptReviewPipeline(
  state: ReviewPipelineDraftState,
  pipeline: DesktopReviewPipeline
): ReviewPipelineDraftState {
  return {
    ...state,
    base: pipeline,
    latest: pipeline,
    steps: pipeline.steps,
    stepKeys: pipeline.steps.map((_, index) => state.nextStepKey + index),
    nextStepKey: state.nextStepKey + pipeline.steps.length,
    defaultCycles: pipeline.packageDefaults.maxFeedbackCycles
  };
}

export function refreshReviewPipelineDraft(
  state: ReviewPipelineDraftState,
  pipeline: DesktopReviewPipeline
): ReviewPipelineDraftState {
  if (
    state.latest &&
    state.latest.taskTitle === pipeline.taskTitle &&
    reviewPipelineFingerprint(
      state.latest.steps,
      state.latest.packageDefaults.maxFeedbackCycles
    ) === reviewPipelineFingerprint(pipeline.steps, pipeline.packageDefaults.maxFeedbackCycles)
  )
    return state;
  return reviewPipelineIsDirty(state) || reviewPipelineHasConflict(state)
    ? { ...state, latest: pipeline }
    : adoptReviewPipeline(state, pipeline);
}

export function acknowledgeReviewPipelineSave(
  current: ReviewPipelineDraftState,
  sent: ReviewPipelineDraftState,
  latest: DesktopReviewPipeline,
  submittedSteps: DesktopReviewPipelineStepInput[],
  submittedDefaultCycles: number
): ReviewPipelineDraftState {
  const contentFingerprint = (step: DesktopReviewPipelineStepInput) =>
    reviewPipelineFingerprint(
      [{ ...step, blockId: "", promptMarkdown: step.promptMarkdown.trim() }],
      0
    );
  const existingIds = new Set(sent.base?.steps.map((step) => step.blockId));
  const steps = submittedSteps.map((step, index) => {
    const content = normalizeReviewPipelineStepContent(step);
    const candidate = latest.steps[index];
    const assignedId =
      !step.blockId &&
      candidate &&
      !existingIds.has(candidate.blockId) &&
      contentFingerprint({ ...content, blockId: "" }) === contentFingerprint(candidate)
        ? candidate.blockId
        : step.blockId;
    return { ...content, blockId: assignedId, blockRef: `${latest.taskId}#${assignedId}` };
  });
  const submitted: DesktopReviewPipeline = {
    ...latest,
    steps,
    packageDefaults: { maxFeedbackCycles: submittedDefaultCycles, completionPolicy: "strict" }
  };
  const receiptFingerprint = (pipeline: DesktopReviewPipeline) =>
    reviewPipelineFingerprint(
      pipeline.steps.map((step) => ({ ...step, promptMarkdown: step.promptMarkdown.trim() })),
      pipeline.packageDefaults.maxFeedbackCycles
    );
  const matchesSubmission = receiptFingerprint(submitted) === receiptFingerprint(latest);
  if (matchesSubmission && current.revision === sent.revision)
    return adoptReviewPipeline(current, latest);
  const draftSteps = current.steps.map((step, index) => {
    const sentIndex = sent.stepKeys.indexOf(current.stepKeys[index]);
    const savedStep = steps[sentIndex];
    return !step.blockId && savedStep?.blockId
      ? { ...step, blockId: savedStep.blockId, blockRef: savedStep.blockRef }
      : step;
  });
  return { ...current, steps: draftSteps, base: matchesSubmission ? latest : submitted, latest };
}
