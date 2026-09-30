import type { DesktopReviewPipelineStepInput } from "./types/reviewPipelineTypes.js";

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty.`);
  return trimmed;
}

/** The content persisted by a Review Pipeline step, independently of its assigned block id. */
export function normalizeReviewPipelineStepContent(
  step: DesktopReviewPipelineStepInput
): Omit<DesktopReviewPipelineStepInput, "blockId" | "blockRef"> {
  const title = requireNonEmpty(step.title, "Review step title");
  const promptMarkdown =
    step.promptMarkdown.trim() ||
    `# ${title}\n\nReview the completed work and return passed or needs_changes feedback.`;
  return {
    title,
    enabled: step.enabled,
    preset: requireNonEmpty(step.preset, "Review preset"),
    triggerCondition: step.triggerCondition ?? "after_required_work_completed",
    inputContext: requireNonEmpty(step.inputContext, "Review input context"),
    passCriteria: requireNonEmpty(step.passCriteria, "Review pass criteria"),
    feedbackFormat: requireNonEmpty(step.feedbackFormat, "Review feedback format"),
    maxFeedbackCycles: Math.max(0, Math.trunc(step.maxFeedbackCycles)),
    hook: step.hook,
    promptMarkdown: promptMarkdown.endsWith("\n") ? promptMarkdown : `${promptMarkdown}\n`
  };
}
