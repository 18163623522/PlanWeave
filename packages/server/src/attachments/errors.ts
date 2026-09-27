import { z } from "zod";

/** Keep the operation's error identity and diagnostics when cleanup also fails. */
export function withAttachmentCleanupFailure(primary: unknown, cleanup: unknown): unknown {
  if (primary instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(primary, "cause");
    if (
      (!descriptor && Object.isExtensible(primary)) ||
      descriptor?.configurable ||
      (descriptor && "writable" in descriptor && descriptor.writable)
    ) {
      const cause =
        primary.cause === undefined
          ? cleanup
          : new AggregateError([primary.cause, cleanup], "attachment_cleanup_failed");
      Object.defineProperty(primary, "cause", {
        value: cause,
        configurable: descriptor?.configurable ?? true
      });
      return primary;
    }
  }
  return new AggregateError([primary, cleanup], "attachment_operation_and_cleanup_failed", {
    cause: primary
  });
}

export async function withAttachmentCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let result!: T;
  let failure: { error: unknown } | undefined;
  try {
    result = await action();
  } catch (error) {
    failure = { error };
  }
  try {
    await cleanup();
  } catch (error) {
    failure = { error: failure ? withAttachmentCleanupFailure(failure.error, error) : error };
  }
  if (failure) throw failure.error;
  return result;
}

/**
 * Stable error codes for human comment-attachment authorization and staged blob ops.
 * Never include digests, paths, host tokens, or package dumps in messages.
 */
export const attachmentErrorCodeSchema = z.enum([
  "attachment_auth_unauthenticated",
  "attachment_auth_forbidden",
  "attachment_auth_project_mismatch",
  "attachment_role_insufficient",
  "attachment_input_invalid",
  "attachment_not_found",
  "attachment_pending_not_found",
  "attachment_pending_expired",
  "attachment_pending_not_uploader",
  "attachment_status_conflict",
  "attachment_digest_mismatch",
  "attachment_size_mismatch",
  "attachment_media_type",
  "attachment_size_limit",
  "attachment_cross_project_forbidden",
  "attachment_comment_not_found",
  "attachment_too_large"
]);

export type AttachmentErrorCode = z.infer<typeof attachmentErrorCodeSchema>;

export type AttachmentDenial = {
  allowed: false;
  code: AttachmentErrorCode;
  message: string;
};

export type AttachmentAllowance = {
  allowed: true;
};

export type AttachmentAuthDecision = AttachmentAllowance | AttachmentDenial;

export function denyAttachment(code: AttachmentErrorCode, message: string): AttachmentDenial {
  return { allowed: false, code, message };
}

export function allowAttachment(): AttachmentAllowance {
  return { allowed: true };
}

export const ATTACHMENT_ERROR_MESSAGES: Readonly<Record<AttachmentErrorCode, string>> = {
  attachment_auth_unauthenticated: "Authentication required for comment attachment actions.",
  attachment_auth_forbidden: "Comment attachment action is not permitted.",
  attachment_auth_project_mismatch:
    "Authenticated project scope does not match the attachment project.",
  attachment_role_insufficient: "Project role is insufficient for this attachment action.",
  attachment_input_invalid: "Comment attachment input failed validation.",
  attachment_not_found: "Comment attachment was not found in this project.",
  attachment_pending_not_found: "Pending attachment upload was not found in this project.",
  attachment_pending_expired: "Pending attachment upload has expired.",
  attachment_pending_not_uploader: "Only the uploader may stream or finalize this pending upload.",
  attachment_status_conflict: "Pending attachment upload status does not allow this operation.",
  attachment_digest_mismatch: "Attachment content digest does not match the expected digest.",
  attachment_size_mismatch: "Attachment content size does not match the expected size.",
  attachment_media_type: "Comment attachment media type is not allowed.",
  attachment_size_limit: "Comment attachment size exceeds the allowed maximum.",
  attachment_cross_project_forbidden: "Cross-project attachment access is not permitted.",
  attachment_comment_not_found: "Comment was not found for attachment access in this project.",
  attachment_too_large: "Comment attachment body exceeds the declared or allowed size."
};
