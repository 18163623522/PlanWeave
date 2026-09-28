export function missingImplementationClaimIdentityReason(ref: string): string {
  return `Implementation claim '${ref}' has no captured submissionAttemptId. Stop and drain its old executor before using mark-blocked, then unblock and claim/run a new execution cycle. For a remote-owned claim, use the existing remote recovery procedure instead.`;
}
