import { useCallback, useEffect, useRef, useState } from "react";
import type { OperatorControlStatus } from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function selectedProfile(
  status: OperatorControlStatus | null,
  selectedId: string | null,
  origin: string
) {
  const profiles = status?.profiles.filter((item) => originOf(item.serverBaseUrl) === origin) ?? [];
  const profile =
    profiles.find((item) => item.profileId === selectedId) ??
    profiles.find((item) => item.profileId === status?.activeProfileId) ??
    profiles[0] ??
    null;
  return { profiles, profile };
}

export type OperatorControlStatusSnapshot = {
  status: OperatorControlStatus | null;
  loading: boolean;
  error: string | null;
  conflictErrors: Readonly<Record<string, string>>;
  conflictOrigins: Readonly<Record<string, string>>;
  current: () => OperatorControlStatus | null;
  version: () => number;
  refresh: () => Promise<{ ok: true } | { ok: false; error: string }>;
  publish: (status: OperatorControlStatus, expectedVersion: number) => void;
};

export function useOperatorControlStatusSnapshot(): OperatorControlStatusSnapshot {
  const [status, setStatus] = useState<OperatorControlStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflictErrors, setConflictErrors] = useState<Readonly<Record<string, string>>>({});
  const [conflictOrigins, setConflictOrigins] = useState<Readonly<Record<string, string>>>({});
  const current = useRef<OperatorControlStatus | null>(null);
  const revision = useRef(0);
  const alive = useRef(false);
  const pendingConflicts = useRef(new Set<string>());
  const pendingOriginConflicts = useRef(new Set<string>());

  const accept = useCallback((next: OperatorControlStatus) => {
    current.current = next;
    revision.current += 1;
    setStatus(next);
    setLoading(false);
    setError(null);
    setConflictErrors({});
    setConflictOrigins({});
    pendingConflicts.current.clear();
    pendingOriginConflicts.current.clear();
  }, []);

  const publish = useCallback(
    (next: OperatorControlStatus, expectedVersion: number) => {
      if (alive.current && revision.current === expectedVersion) accept(next);
    },
    [accept]
  );

  const refresh = useCallback(async () => {
    if (!operatorControlBridge || !alive.current)
      return { ok: false as const, error: "operator_bridge_unavailable" };
    const startedAt = revision.current;
    try {
      const next = await operatorControlBridge.getOperatorControlStatus();
      if (!alive.current || revision.current !== startedAt)
        return { ok: false as const, error: "operator_status_superseded" };
      accept(next);
      return { ok: true as const };
    } catch (cause) {
      const code = hostAdministrationErrorCode(cause);
      if (alive.current && revision.current === startedAt && !current.current) {
        setLoading(false);
        setError(code);
      }
      return { ok: false as const, error: code };
    }
  }, [accept]);

  useEffect(() => {
    if (!operatorControlBridge) return;
    alive.current = true;
    let active = true;
    const unsubscribe = operatorControlBridge.onOperatorControlStatusChanged((next) => {
      if (!active || !alive.current) return;
      const previous = current.current;
      if (previous?.updatedAt && next.updatedAt) {
        if (next.updatedAt < previous.updatedAt) return;
        if (
          next.updatedAt === previous.updatedAt &&
          JSON.stringify(next) !== JSON.stringify(previous)
        ) {
          const previousProfiles = new Map(
            previous.profiles.map((profile) => [profile.profileId, profile])
          );
          const conflictingProfiles = next.profiles
            .filter(
              (profile) =>
                JSON.stringify(profile) !== JSON.stringify(previousProfiles.get(profile.profileId))
            )
            .map((profile) => profile.profileId);
          for (const profile of previous.profiles) {
            if (!next.profiles.some((item) => item.profileId === profile.profileId))
              conflictingProfiles.push(profile.profileId);
          }
          for (const profileId of conflictingProfiles) pendingConflicts.current.add(profileId);
          const origins = new Set(
            [...previous.profiles, ...next.profiles].map((profile) =>
              originOf(profile.serverBaseUrl)
            )
          );
          for (const origin of origins) {
            if (
              selectedProfile(previous, null, origin).profile?.profileId !==
              selectedProfile(next, null, origin).profile?.profileId
            )
              pendingOriginConflicts.current.add(origin);
          }
          revision.current += 1;
          const conflictVersion = revision.current;
          void refresh().then((result) => {
            if (active && revision.current === conflictVersion && !result.ok) {
              setConflictErrors(
                Object.fromEntries([...pendingConflicts.current].map((id) => [id, result.error]))
              );
              setConflictOrigins(
                Object.fromEntries(
                  [...pendingOriginConflicts.current].map((origin) => [origin, result.error])
                )
              );
            }
          });
          return;
        }
      }
      accept(next);
    });
    void refresh();
    return () => {
      active = false;
      alive.current = false;
      revision.current += 1;
      unsubscribe();
    };
  }, [accept, refresh]);

  return {
    status,
    loading,
    error,
    conflictErrors,
    conflictOrigins,
    current: () => current.current,
    version: () => revision.current,
    refresh,
    publish
  };
}
