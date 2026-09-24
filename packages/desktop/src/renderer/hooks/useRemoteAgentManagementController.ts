import { useCallback, useEffect, useRef, useState } from "react";
import { operatorControlBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";
import { useOwnerControlPlaneAvailability } from "./useOwnerControlPlaneAvailability";
import type { OperatorRemoteAgentView } from "../../shared/operatorControl";
import { useRemoteAgentCatalog, type RemoteAgentCatalog } from "./useRemoteAgentCatalog";

export type {
  RemoteAgentCatalog,
  RemoteAgentPeopleOption,
  RemoteAgentWorkspaceOption
} from "./useRemoteAgentCatalog";

export type RemoteAgentInventory = {
  agents: OperatorRemoteAgentView[];
  humanPrincipalId: string | null;
  operatorProfileId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export type RemoteAgentManagementActions = {
  busy: boolean;
  actionError: string | null;
  retryAction: () => Promise<void>;
  setAccessMode: (
    endpointId: string,
    accessMode: OperatorRemoteAgentView["accessMode"],
    allowOwnerCanvas?: boolean
  ) => Promise<boolean>;
  grantWorkspace: (endpointId: string, workspaceId: string) => Promise<boolean>;
  revokeGrant: (endpointId: string, workspaceId: string) => Promise<boolean>;
  revokeAgent: (endpointId: string) => Promise<boolean>;
  repairOwnership: (endpointId: string, ownerHumanPrincipalId: string) => Promise<boolean>;
};

export type RemoteAgentManagementController = RemoteAgentInventory &
  RemoteAgentCatalog &
  RemoteAgentManagementActions;

export function useRemoteAgentManagementController(): RemoteAgentManagementController {
  const ownerControlPlane = useOwnerControlPlaneAvailability();
  const humanPrincipalId = ownerControlPlane.humanPrincipalId;
  const operatorProfileId = ownerControlPlane.operatorProfileId;
  const [agents, setAgents] = useState<OperatorRemoteAgentView[]>([]);
  const ownerProfile = ownerControlPlane.status?.profiles.find(
    (profile) => profile.profileId === operatorProfileId
  );
  const catalog = useRemoteAgentCatalog({
    operatorProfileId,
    humanPrincipalId,
    serverBaseUrl: ownerProfile?.serverBaseUrl ?? null
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inventoryGeneration = useRef(0);
  const identityGeneration = useRef(0);
  const inventoryIdentity = JSON.stringify([
    operatorProfileId,
    humanPrincipalId,
    ownerProfile?.serverBaseUrl ?? null,
    ownerProfile?.hasOperatorCredential ?? false,
    ownerProfile?.credentialRevision ?? null
  ]);
  const activeIdentity = useRef(inventoryIdentity);

  useEffect(() => {
    activeIdentity.current = inventoryIdentity;
    identityGeneration.current += 1;
    inventoryGeneration.current += 1;
    setAgents([]);
    setBusy(false);
    setActionError(null);
    setError(null);
    return () => {
      identityGeneration.current += 1;
      inventoryGeneration.current += 1;
    };
  }, [inventoryIdentity]);

  const refresh = useCallback(async () => {
    const generation = ++inventoryGeneration.current;
    const isCurrent = () =>
      generation === inventoryGeneration.current && activeIdentity.current === inventoryIdentity;
    if (
      !operatorControlBridge ||
      !operatorProfileId ||
      !humanPrincipalId ||
      !ownerProfile?.hasOperatorCredential
    ) {
      setAgents([]);
      setError(
        ownerProfile?.hasOperatorCredential === false ? "operator_credential_missing" : null
      );
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await operatorControlBridge.listOperatorRemoteAgents({
        profileId: operatorProfileId,
        humanPrincipalId
      });
      if (!isCurrent()) return;
      setAgents(list.items);
      setError(null);
    } catch (caught) {
      if (isCurrent()) setError(hostAdministrationErrorCode(caught));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [humanPrincipalId, operatorProfileId, inventoryIdentity, ownerProfile?.hasOperatorCredential]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(
    async (action: () => Promise<OperatorRemoteAgentView>): Promise<boolean> => {
      if (
        !operatorControlBridge ||
        !operatorProfileId ||
        !humanPrincipalId ||
        !ownerProfile?.hasOperatorCredential ||
        activeIdentity.current !== inventoryIdentity
      )
        return false;
      const identity = identityGeneration.current;
      setBusy(true);
      try {
        const changed = await action();
        if (identity !== identityGeneration.current) return false;
        setActionError(null);
        inventoryGeneration.current += 1;
        setLoading(false);
        setAgents((current) => {
          if (changed.ownerHumanPrincipalId !== humanPrincipalId) {
            return current.filter((agent) => agent.endpointId !== changed.endpointId);
          }
          return current.some((agent) => agent.endpointId === changed.endpointId)
            ? current.map((agent) => (agent.endpointId === changed.endpointId ? changed : agent))
            : [...current, changed];
        });
        return true;
      } catch (caught) {
        if (identity === identityGeneration.current)
          setActionError(hostAdministrationErrorCode(caught));
        return false;
      } finally {
        if (identity === identityGeneration.current) setBusy(false);
      }
    },
    [humanPrincipalId, operatorProfileId, inventoryIdentity, ownerProfile?.hasOperatorCredential]
  );

  return {
    agents: activeIdentity.current === inventoryIdentity ? agents : [],
    ...catalog,
    humanPrincipalId,
    operatorProfileId,
    loading: loading || activeIdentity.current !== inventoryIdentity,
    busy,
    error: activeIdentity.current === inventoryIdentity ? error : null,
    actionError,
    retryAction: async () => {
      setActionError(null);
      await refresh();
    },
    refresh,
    setAccessMode: (endpointId, accessMode, allowOwnerCanvas) => {
      const current = agents.find((agent) => agent.endpointId === endpointId);
      return runMutation(() =>
        operatorControlBridge!.setOperatorRemoteAgentAccessMode({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          accessMode,
          ...(allowOwnerCanvas === undefined ? {} : { allowOwnerCanvas }),
          ...(current ? { expectedPolicyRevision: current.policyRevision } : {})
        })
      );
    },
    grantWorkspace: (endpointId, workspaceId) => {
      const grant = agents
        .find((agent) => agent.endpointId === endpointId)
        ?.grants.find((item) => item.workspaceId === workspaceId);
      return runMutation(() =>
        operatorControlBridge!.grantOperatorRemoteAgentWorkspace({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          workspaceId,
          ...(grant ? { expectedGrantRevision: grant.grantRevision } : {})
        })
      );
    },
    revokeGrant: (endpointId, workspaceId) =>
      runMutation(() =>
        operatorControlBridge!.revokeOperatorRemoteAgentGrant({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          workspaceId
        })
      ),
    revokeAgent: (endpointId) =>
      runMutation(() =>
        operatorControlBridge!.revokeOperatorRemoteAgent({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId
        })
      ),
    repairOwnership: (endpointId, ownerHumanPrincipalId) =>
      runMutation(() =>
        operatorControlBridge!.repairOperatorRemoteAgentOwnership({
          profileId: operatorProfileId!,
          endpointId,
          ownerHumanPrincipalId
        })
      )
  };
}
