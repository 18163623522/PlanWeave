import { useEffect, useRef, useState } from "react";
import type {
  OperatorCopyMemberSetupCodeInput,
  OperatorMemberSetupCodeHandoffView
} from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";
import { originOf, type OperatorControlStatusSnapshot } from "./useOperatorControlStatusSnapshot";

export function useMemberSetupCode(
  snapshot: OperatorControlStatusSnapshot,
  target: OperatorCopyMemberSetupCodeInput | null,
  workspaceProfileId: string | null,
  workspaceCredentialRevision: string | null
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<OperatorMemberSetupCodeHandoffView | null>(null);
  const identity = JSON.stringify([
    workspaceProfileId,
    workspaceCredentialRevision,
    target,
    snapshot.version()
  ]);
  const currentIdentity = useRef(identity);
  const generation = useRef(0);
  const alive = useRef(false);
  const pending = useRef(false);
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity;
    generation.current += 1;
    pending.current = false;
  }
  useEffect(() => {
    currentIdentity.current = identity;
    alive.current = true;
    setBusy(false);
    setError(null);
    setHandoff(null);
    return () => {
      alive.current = false;
      generation.current += 1;
      pending.current = false;
    };
  }, [identity]);

  const copy = async (): Promise<boolean | null> => {
    if (pending.current) return null;
    if (!target || !operatorControlBridge) return false;
    const origin = originOf(target.serverBaseUrl);
    const status = snapshot.current();
    const profile = status?.profiles.find((item) => item.profileId === target.profileId);
    if (
      !profile?.hasOperatorCredential ||
      originOf(profile.serverBaseUrl) !== origin ||
      snapshot.conflictErrors[target.profileId] ||
      snapshot.conflictOrigins[origin]
    ) {
      setError("operator_credential_missing");
      return false;
    }
    const operation = ++generation.current;
    const version = snapshot.version();
    const startedIdentity = currentIdentity.current;
    const isCurrent = () =>
      alive.current &&
      generation.current === operation &&
      currentIdentity.current === startedIdentity &&
      snapshot.version() === version;
    pending.current = true;
    setBusy(true);
    setError(null);
    setHandoff(null);
    try {
      const result = await operatorControlBridge.copyOperatorMemberSetupCode(target);
      if (!isCurrent()) return null;
      setHandoff(result);
      return true;
    } catch (cause) {
      if (!isCurrent()) return null;
      setError(hostAdministrationErrorCode(cause));
      return false;
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return { busy, error, handoff, copy, identity };
}
