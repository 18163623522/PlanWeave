import { useEffect, useRef, useState } from "react";
import type { OperatorProfileView } from "../../shared/operatorControl";
import type { OperatorManagementView } from "../../shared/operatorManagement";
import { operatorControlBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";
import {
  originOf,
  selectedProfile,
  type OperatorControlStatusSnapshot
} from "./useOperatorControlStatusSnapshot";

type Authority = { key: string; generation: number };
type Bound<T> = { generation: number; value: T };

function authorityKey(profile: OperatorProfileView | null, origin: string): string {
  return JSON.stringify(
    profile
      ? [
          profile.profileId,
          originOf(profile.serverBaseUrl),
          profile.operatorId,
          profile.hasOperatorCredential,
          profile.operatorCredentialPersistence,
          profile.credentialRevision
        ]
      : [null, origin]
  );
}

function sameTarget(profile: OperatorProfileView | null, original: OperatorProfileView): boolean {
  return (
    profile?.profileId === original.profileId &&
    originOf(profile.serverBaseUrl) === originOf(original.serverBaseUrl) &&
    profile.operatorId === original.operatorId
  );
}

export function useServerManagementAuthorization(
  serverOrigin: string,
  operatorStatus: OperatorControlStatusSnapshot
) {
  const { status } = operatorStatus;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorState, setError] = useState<Bound<string> | null>(null);
  const [busyState, setBusy] = useState<Bound<boolean> | null>(null);
  const [checkingState, setChecking] = useState<Bound<boolean> | null>(null);
  const [verifiedState, setVerified] = useState<Bound<string> | null>(null);
  const [managementState, setManagement] = useState<Bound<OperatorManagementView> | null>(null);
  const selectedRef = useRef(selectedId);
  const requestSequence = useRef(0);
  const operationSequence = useRef(0);
  const actionInFlight = useRef<{
    target: OperatorProfileView;
    sequence: number;
    startingGeneration: number;
  } | null>(null);
  const actionResultGeneration = useRef<number | null>(null);
  const refreshCheck = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  const { profiles, profile } = selectedProfile(status, selectedId, serverOrigin);
  if (actionInFlight.current && !sameTarget(profile, actionInFlight.current.target)) {
    operationSequence.current += 1;
    actionInFlight.current = null;
  }
  const profileId = profile?.profileId;
  const key = authorityKey(profile, serverOrigin);
  const authority = useRef<Authority>({ key, generation: 0 });
  if (authority.current.key !== key) {
    authority.current = { key, generation: authority.current.generation + 1 };
    requestSequence.current += 1;
  }
  const generation = authority.current.generation;
  const current = () =>
    selectedProfile(operatorStatus.current(), selectedRef.current, serverOrigin).profile;
  const syncAuthority = () => {
    const currentProfile = current();
    if (actionInFlight.current && !sameTarget(currentProfile, actionInFlight.current.target)) {
      operationSequence.current += 1;
      actionInFlight.current = null;
    }
    const nextKey = authorityKey(currentProfile, serverOrigin);
    if (authority.current.key !== nextKey) {
      authority.current = { key: nextKey, generation: authority.current.generation + 1 };
      requestSequence.current += 1;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      operationSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    const bridge = operatorControlBridge;
    if (!bridge || !profileId) return;
    let active = true;
    const effectGeneration = generation;
    const refresh = () => {
      if (
        !active ||
        authority.current.generation !== effectGeneration ||
        (actionInFlight.current?.target.profileId === profileId &&
          actionInFlight.current.startingGeneration === effectGeneration)
      )
        return;
      const sequence = ++requestSequence.current;
      setChecking({ generation: effectGeneration, value: true });
      void bridge
        .getManagementAuthorization({ profileId })
        .then(
          (view) => {
            if (
              !active ||
              authority.current.generation !== effectGeneration ||
              requestSequence.current !== sequence ||
              view.profileId !== profileId
            )
              return;
            setManagement({ generation: effectGeneration, value: view });
            setError(null);
            if (view.errorCode || !view.authorization) setVerified(null);
          },
          (cause) => {
            if (
              active &&
              authority.current.generation === effectGeneration &&
              requestSequence.current === sequence
            )
              setError({ generation: effectGeneration, value: hostAdministrationErrorCode(cause) });
          }
        )
        .finally(() => {
          if (
            active &&
            authority.current.generation === effectGeneration &&
            requestSequence.current === sequence
          )
            setChecking({ generation: effectGeneration, value: false });
        });
    };
    refreshCheck.current = refresh;
    if (actionResultGeneration.current !== effectGeneration) refresh();
    const timer = setInterval(refresh, 5 * 60_000);
    return () => {
      active = false;
      clearInterval(timer);
      requestSequence.current += 1;
      if (refreshCheck.current === refresh) refreshCheck.current = null;
    };
  }, [profileId, generation]);

  const busy = busyState?.generation === generation && busyState.value;
  const checking = checkingState?.generation === generation && checkingState.value;
  const management =
    managementState?.generation === generation &&
    managementState.value.profileId === profileId &&
    profile?.hasOperatorCredential
      ? managementState.value
      : null;
  const selectionConflict = profiles.some((item) => item.profileId === selectedId)
    ? null
    : operatorStatus.conflictOrigins[serverOrigin];
  const error =
    errorState?.generation === generation
      ? errorState.value
      : ((profileId ? operatorStatus.conflictErrors[profileId] : null) ??
        selectionConflict ??
        operatorStatus.error);
  const verifiedId = verifiedState?.generation === generation ? verifiedState.value : null;

  const run = async (
    operation: "import" | "reauthorize" | "recover" | "revoke",
    recoveryCode?: string
  ) => {
    if (!operatorControlBridge || !profile || busy) return false;
    const target = profile;
    const sequence = ++operationSequence.current;
    const startingGeneration = authority.current.generation;
    actionInFlight.current = { target, sequence, startingGeneration };
    const stillTarget = () =>
      mounted.current && operationSequence.current === sequence && sameTarget(current(), target);
    setBusy({ generation: startingGeneration, value: true });
    setError(null);
    setVerified(null);
    let readSequence = ++requestSequence.current;
    let readGeneration = startingGeneration;
    const actionAuthorityKey = authorityKey(target, serverOrigin);
    try {
      let view: OperatorManagementView;
      if (operation === "import") {
        const before = operatorStatus.version();
        const next = await operatorControlBridge.importOperatorCredential({
          profileId: target.profileId,
          verifyBeforeSave: true
        });
        if (!stillTarget()) return false;
        operatorStatus.publish(next, before);
        syncAuthority();
        if (!stillTarget()) return false;
        readGeneration = authority.current.generation;
        readSequence = ++requestSequence.current;
        view = await operatorControlBridge.getManagementAuthorization({
          profileId: target.profileId
        });
      } else {
        view =
          operation === "revoke"
            ? await operatorControlBridge.revokeManagementDevice({
                profileId: target.profileId,
                deviceId: recoveryCode ?? ""
              })
            : operation === "recover"
              ? await operatorControlBridge.recoverManagement({
                  profileId: target.profileId,
                  recoveryCode: recoveryCode ?? ""
                })
              : await operatorControlBridge.reauthorizeManagement({ profileId: target.profileId });
        if (!stillTarget()) return false;
        const refreshed = await operatorStatus.refresh();
        if (!refreshed.ok && authorityKey(current(), serverOrigin) === actionAuthorityKey) {
          if (stillTarget())
            setError({ generation: authority.current.generation, value: refreshed.error });
          return false;
        }
        if (!stillTarget()) return false;
        syncAuthority();
        if (!stillTarget()) return false;
        if (authority.current.generation !== startingGeneration) {
          readGeneration = authority.current.generation;
          readSequence = ++requestSequence.current;
          view = await operatorControlBridge.getManagementAuthorization({
            profileId: target.profileId
          });
        }
      }
      if (
        !stillTarget() ||
        authority.current.generation !== readGeneration ||
        requestSequence.current !== readSequence ||
        view.profileId !== target.profileId
      )
        return false;
      const resultGeneration = authority.current.generation;
      actionResultGeneration.current = resultGeneration;
      requestSequence.current += 1;
      setManagement({ generation: resultGeneration, value: view });
      setError(null);
      setChecking({ generation: resultGeneration, value: false });
      if (
        operation !== "revoke" &&
        (view.errorCode || !view.authorization || !current()?.hasOperatorCredential)
      )
        return false;
      if (operation !== "revoke")
        setVerified({ generation: resultGeneration, value: target.profileId });
      return true;
    } catch (cause) {
      if (stillTarget() && authority.current.generation === readGeneration)
        setError({
          generation: authority.current.generation,
          value: hostAdministrationErrorCode(cause)
        });
      return false;
    } finally {
      if (actionInFlight.current?.sequence === sequence) actionInFlight.current = null;
      if (stillTarget()) setBusy({ generation: authority.current.generation, value: false });
    }
  };

  return {
    status,
    identityGeneration: generation,
    profiles,
    profileId,
    profile,
    busy,
    checking,
    management,
    error,
    verifiedId,
    refresh: () => {
      setError(null);
      setVerified(null);
      refreshCheck.current?.();
    },
    importCredential: () => run("import"),
    reauthorize: () => run("reauthorize"),
    revoke: (deviceId: string) => run("revoke", deviceId),
    recover: (code: string) => run("recover", code),
    selectProfile: (id: string) => {
      selectedRef.current = id;
      syncAuthority();
      setSelectedId(id);
    }
  };
}
