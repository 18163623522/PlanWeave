import { useCallback, useEffect, useRef, useState } from "react";
import { collaborationBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";
import { useCollaborationStatus } from "./useCollaborationStatus";

export type RemoteAgentPeopleOption = {
  humanPrincipalId: string;
  displayName: string;
};

export type RemoteAgentWorkspaceOption = {
  workspaceId: string;
  displayName: string;
};

type Page<Item> = { items: Item[]; nextCursor: number | null };
type PagedCatalog<Item> = {
  items: Item[];
  nextCursor: number | null;
  loading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
};

type PageState<Item> = {
  items: Item[];
  nextCursor: number | null;
  loading: boolean;
  error: string | null;
  loaded: boolean;
};

function emptyPage<Item>(): PageState<Item> {
  return { items: [], nextCursor: null, loading: false, error: null, loaded: false };
}

function useCatalogPage<Source, Item>(input: {
  active: boolean;
  identity: string;
  ready: boolean;
  load: (cursor: number) => Promise<Page<Source>>;
  select: (item: Source) => Item | null;
  key: (item: Item) => string;
}): PagedCatalog<Item> {
  const [state, setState] = useState<PageState<Item>>(emptyPage);
  const epoch = useRef({
    value: 0,
    pending: false,
    identity: "",
    snapshot: emptyPage<Item>()
  }).current;

  const request = useCallback(
    async (cursor: number, force: boolean) => {
      if (!input.active || !input.ready || (!force && epoch.pending)) return;
      const requestEpoch = ++epoch.value;
      epoch.pending = true;
      const before = epoch.snapshot;
      const loading = { ...before, loading: true, error: null };
      epoch.snapshot = loading;
      setState(loading);
      try {
        const page = await input.load(cursor);
        if (requestEpoch !== epoch.value) return;
        if (page.items.length > 100 || (page.nextCursor !== null && page.nextCursor <= cursor)) {
          throw new Error("remote_agent_catalog_cursor_invalid");
        }
        const items = new Map<string, Item>();
        for (const item of cursor === 0 ? [] : before.items) items.set(input.key(item), item);
        for (const source of page.items) {
          const item = input.select(source);
          if (item) items.set(input.key(item), item);
        }
        const next = {
          items: [...items.values()],
          nextCursor: page.nextCursor,
          loading: false,
          error: null,
          loaded: true
        };
        epoch.snapshot = next;
        setState(next);
      } catch (caught) {
        if (requestEpoch !== epoch.value) return;
        const next = {
          ...before,
          loading: false,
          error:
            caught instanceof Error && caught.message === "remote_agent_catalog_cursor_invalid"
              ? caught.message
              : hostAdministrationErrorCode(caught)
        };
        epoch.snapshot = next;
        setState(next);
      } finally {
        if (requestEpoch === epoch.value) epoch.pending = false;
      }
    },
    [epoch, input.active, input.ready, input.load, input.select, input.key]
  );

  useEffect(() => {
    epoch.value += 1;
    epoch.pending = false;
    epoch.identity = input.identity;
    epoch.snapshot = emptyPage<Item>();
    setState(epoch.snapshot);
    if (input.active && input.ready) void request(0, false);
    return () => {
      epoch.value += 1;
      epoch.pending = false;
    };
  }, [epoch, input.active, input.identity, input.ready, request]);

  const loadMore = useCallback(async () => {
    const current = epoch.snapshot;
    if (current.loading || current.error || !current.loaded || current.nextCursor === null) return;
    await request(current.nextCursor, false);
  }, [epoch, request]);
  const retry = useCallback(async () => {
    const current = epoch.snapshot;
    await request(current.loaded ? (current.nextCursor ?? 0) : 0, true);
  }, [epoch, request]);

  const visible = input.active && input.ready && epoch.identity === input.identity;
  return {
    items: visible ? state.items : [],
    nextCursor: visible ? state.nextCursor : null,
    loading: visible && state.loading,
    error: visible ? state.error : null,
    loadMore,
    retry
  };
}

export type RemoteAgentCatalog = {
  people: RemoteAgentPeopleOption[];
  peopleNextCursor: number | null;
  peopleLoading: boolean;
  peopleError: string | null;
  loadMorePeople: () => Promise<void>;
  retryPeople: () => Promise<void>;
  workspaces: RemoteAgentWorkspaceOption[];
  workspacesNextCursor: number | null;
  workspacesLoading: boolean;
  workspacesError: string | null;
  loadMoreWorkspaces: () => Promise<void>;
  retryWorkspaces: () => Promise<void>;
  acquireCatalog: (scope?: "people" | "workspaces" | "both") => void;
  releaseCatalog: (scope?: "people" | "workspaces" | "both") => void;
};

export function useRemoteAgentCatalog(owner: {
  operatorProfileId: string | null;
  humanPrincipalId: string | null;
  serverBaseUrl: string | null;
}): RemoteAgentCatalog {
  const {
    status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus
  } = useCollaborationStatus();
  const [consumers, setConsumers] = useState({ people: 0, workspaces: 0 });
  const [selfAttempt, setSelfAttempt] = useState(0);
  const [workspaceSelf, setWorkspaceSelf] = useState<{
    identity: string;
    humanPrincipalId: string | null;
    deviceSessionId: string | null;
    error: string | null;
  } | null>(null);
  const activeProfile = status?.profiles.find(
    (profile) => profile.profileId === status.activeProfileId
  );
  const connection = status?.workspaceConnection;
  const ownerOrigin = owner.serverBaseUrl ? new URL(owner.serverBaseUrl).origin : null;
  const collaborationOrigin = activeProfile ? new URL(activeProfile.serverBaseUrl).origin : null;
  const connectionOrigin = connection?.profile
    ? new URL(connection.profile.serverBaseUrl).origin
    : null;
  const peopleIdentity = JSON.stringify([
    owner.operatorProfileId,
    owner.humanPrincipalId,
    ownerOrigin,
    status?.activeProfileId ?? null,
    activeProfile?.serverBaseUrl ?? null,
    activeProfile?.humanPrincipalId ?? null,
    activeProfile?.deviceCredentialId ?? null,
    activeProfile?.credentialRevision ?? null,
    status?.session.activeProfileId ?? null,
    connection?.workspaceId ?? null
  ]);
  const workspaceIdentity = JSON.stringify([
    owner.operatorProfileId,
    owner.humanPrincipalId,
    ownerOrigin,
    connection?.status ?? null,
    connection?.profile?.profileId ?? null,
    connection?.profile?.serverBaseUrl ?? null,
    connection?.workspaceId ?? null,
    connection?.connectedAt ?? null,
    connection?.credentialRevision ?? null
  ]);
  const workspaceVerificationIdentity = JSON.stringify([workspaceIdentity, selfAttempt]);
  const peopleReady = Boolean(
    owner.operatorProfileId &&
      owner.humanPrincipalId &&
      ownerOrigin &&
      activeProfile &&
      collaborationOrigin === ownerOrigin &&
      activeProfile.humanPrincipalId === owner.humanPrincipalId &&
      status?.session.phase === "connected" &&
      collaborationBridge
  );
  const workspaceBaseReady = Boolean(
    owner.operatorProfileId &&
      owner.humanPrincipalId &&
      ownerOrigin &&
      collaborationBridge &&
      connection?.status === "connected" &&
      connection.profile &&
      connectionOrigin === ownerOrigin &&
      connection.workspaceId
  );
  const activePeople = consumers.people > 0;
  const activeWorkspaces = consumers.workspaces > 0;
  const acquireCatalog = useCallback(
    (scope: "people" | "workspaces" | "both" = "both") =>
      setConsumers((current) => ({
        people: current.people + (scope === "people" || scope === "both" ? 1 : 0),
        workspaces: current.workspaces + (scope === "workspaces" || scope === "both" ? 1 : 0)
      })),
    []
  );
  const releaseCatalog = useCallback(
    (scope: "people" | "workspaces" | "both" = "both") =>
      setConsumers((current) => ({
        people: Math.max(0, current.people - (scope === "people" || scope === "both" ? 1 : 0)),
        workspaces: Math.max(
          0,
          current.workspaces - (scope === "workspaces" || scope === "both" ? 1 : 0)
        )
      })),
    []
  );

  useEffect(() => {
    setWorkspaceSelf(null);
    const bridge = collaborationBridge;
    if (!activeWorkspaces || !workspaceBaseReady || !bridge) return;
    let cancelled = false;
    void (async () => {
      const live = await bridge.getActiveWorkspaceConnection();
      if (
        live.status !== "connected" ||
        live.profile?.profileId !== connection?.profile?.profileId ||
        live.profile?.serverBaseUrl !== connection?.profile?.serverBaseUrl ||
        live.workspaceId !== connection?.workspaceId ||
        live.connectedAt !== connection?.connectedAt ||
        live.credentialRevision !== connection?.credentialRevision
      ) {
        throw new Error("remote_agent_catalog_identity_unavailable");
      }
      return bridge.getWorkspaceConnectionSelf();
    })().then(
      (self) => {
        if (cancelled) return;
        setWorkspaceSelf({
          identity: workspaceVerificationIdentity,
          humanPrincipalId: self.humanPrincipalId,
          deviceSessionId: self.deviceSessionId,
          error:
            self.humanPrincipalId === owner.humanPrincipalId &&
            self.workspaceId === connection?.workspaceId
              ? null
              : "remote_agent_catalog_identity_unavailable"
        });
      },
      (caught) => {
        if (!cancelled)
          setWorkspaceSelf({
            identity: workspaceVerificationIdentity,
            humanPrincipalId: null,
            deviceSessionId: null,
            error:
              caught instanceof Error &&
              caught.message === "remote_agent_catalog_identity_unavailable"
                ? caught.message
                : hostAdministrationErrorCode(caught)
          });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaces,
    workspaceBaseReady,
    workspaceVerificationIdentity,
    owner.humanPrincipalId,
    connection?.workspaceId,
    connection?.profile?.profileId,
    connection?.profile?.serverBaseUrl,
    connection?.connectedAt,
    connection?.credentialRevision
  ]);
  const matchedSelf =
    workspaceSelf?.identity === workspaceVerificationIdentity ? workspaceSelf : null;
  const workspaceReady = Boolean(workspaceBaseReady && matchedSelf && !matchedSelf.error);
  const workspacePageIdentity = JSON.stringify([
    workspaceIdentity,
    matchedSelf?.deviceSessionId ?? null
  ]);

  const loadPeople = useCallback(
    (cursor: number) => collaborationBridge!.listCollaborationMembers({ cursor, limit: 100 }),
    []
  );
  const loadWorkspaces = useCallback(
    (cursor: number) => collaborationBridge!.listWorkspacePicker({ cursor, limit: 100 }),
    []
  );
  const selectPerson = useCallback(
    (person: { humanPrincipalId: string; displayName: string }) => ({
      humanPrincipalId: person.humanPrincipalId,
      displayName: person.displayName
    }),
    []
  );
  const selectWorkspace = useCallback(
    (workspace: {
      workspaceId: string;
      displayName: string;
      membershipActive: boolean;
      archivedAt: string | null;
    }) =>
      workspace.membershipActive && !workspace.archivedAt
        ? { workspaceId: workspace.workspaceId, displayName: workspace.displayName }
        : null,
    []
  );
  const personKey = useCallback((person: RemoteAgentPeopleOption) => person.humanPrincipalId, []);
  const workspaceKey = useCallback(
    (workspace: RemoteAgentWorkspaceOption) => workspace.workspaceId,
    []
  );
  const people = useCatalogPage({
    active: activePeople,
    identity: peopleIdentity,
    ready: peopleReady,
    load: loadPeople,
    select: selectPerson,
    key: personKey
  });
  const workspaces = useCatalogPage({
    active: activeWorkspaces,
    identity: workspacePageIdentity,
    ready: workspaceReady,
    load: loadWorkspaces,
    select: selectWorkspace,
    key: workspaceKey
  });
  const peopleIdentityError =
    activePeople && !peopleReady && !statusLoading
      ? statusError
        ? "operator_request_failed"
        : "remote_agent_catalog_identity_unavailable"
      : null;
  const workspaceIdentityError =
    activeWorkspaces &&
    !workspaceReady &&
    !statusLoading &&
    (!workspaceBaseReady || matchedSelf?.error)
      ? (matchedSelf?.error ??
        (statusError ? "operator_request_failed" : "remote_agent_catalog_identity_unavailable"))
      : null;
  const retryPeople = useCallback(async () => {
    if (!peopleReady) await refreshStatus();
    else await people.retry();
  }, [peopleReady, refreshStatus, people.retry]);
  const retryWorkspaces = useCallback(async () => {
    if (!workspaceBaseReady) await refreshStatus();
    else if (matchedSelf?.error === "remote_agent_catalog_identity_unavailable") {
      await refreshStatus();
      setSelfAttempt((count) => count + 1);
    } else if (!workspaceReady) setSelfAttempt((count) => count + 1);
    else await workspaces.retry();
  }, [workspaceBaseReady, workspaceReady, matchedSelf?.error, refreshStatus, workspaces.retry]);

  return {
    people: people.items,
    peopleNextCursor: people.nextCursor,
    peopleLoading: people.loading || (activePeople && statusLoading),
    peopleError: people.error ?? peopleIdentityError,
    loadMorePeople: people.loadMore,
    retryPeople,
    workspaces: workspaces.items,
    workspacesNextCursor: workspaces.nextCursor,
    workspacesLoading:
      workspaces.loading ||
      (activeWorkspaces && (statusLoading || (workspaceBaseReady && !matchedSelf))),
    workspacesError: workspaces.error ?? workspaceIdentityError,
    loadMoreWorkspaces: workspaces.loadMore,
    retryWorkspaces,
    acquireCatalog,
    releaseCatalog
  };
}
