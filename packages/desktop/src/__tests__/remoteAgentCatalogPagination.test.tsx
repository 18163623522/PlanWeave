/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteAgentCatalog } from "../renderer/hooks/useRemoteAgentCatalog";
import { useRemoteAgentManagementController } from "../renderer/hooks/useRemoteAgentManagementController";
import type { OperatorRemoteAgentView } from "../shared/operatorControl";

const spies = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listPicker: vi.fn(),
  getSelf: vi.fn(),
  getConnection: vi.fn(),
  listProjects: vi.fn(),
  listCanvases: vi.fn(),
  listAgents: vi.fn(),
  setAccessMode: vi.fn(),
  grantWorkspace: vi.fn(),
  repairOwnership: vi.fn(),
  status: {
    activeProfileId: "collab-a",
    profiles: [
      {
        profileId: "collab-a",
        serverBaseUrl: "https://server.example/",
        humanPrincipalId: "human-a",
        credentialRevision: "collab-revision-a"
      }
    ],
    session: { phase: "connected" },
    workspaceConnection: {
      status: "connected",
      workspaceId: "workspace-a",
      credentialRevision: "credential-a",
      profile: { profileId: "workspace-profile-a", serverBaseUrl: "https://server.example/" }
    }
  },
  owner: {
    operatorProfileId: "operator-a",
    humanPrincipalId: "human-a",
    status: {
      profiles: [
        {
          profileId: "operator-a",
          serverBaseUrl: "https://server.example/",
          hasOperatorCredential: true,
          credentialRevision: "revision-a" as string | null
        }
      ]
    }
  }
}));

vi.mock("../renderer/bridge", () => ({
  collaborationBridge: {
    listCollaborationMembers: spies.listMembers,
    listWorkspacePicker: spies.listPicker,
    getWorkspaceConnectionSelf: spies.getSelf,
    getActiveWorkspaceConnection: spies.getConnection,
    listCollaborationAuthorizedProjects: spies.listProjects,
    listCollaborationAuthorizedCanvases: spies.listCanvases
  },
  operatorControlBridge: {
    listOperatorRemoteAgents: spies.listAgents,
    setOperatorRemoteAgentAccessMode: spies.setAccessMode,
    grantOperatorRemoteAgentWorkspace: spies.grantWorkspace,
    repairOperatorRemoteAgentOwnership: spies.repairOwnership
  }
}));
vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: spies.status,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}));
vi.mock("../renderer/hooks/useOwnerControlPlaneAvailability", () => ({
  useOwnerControlPlaneAvailability: () => spies.owner
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const owner = {
  operatorProfileId: "operator-a",
  humanPrincipalId: "human-a",
  serverBaseUrl: "https://server.example/"
};
const member = (index: number) => ({
  humanPrincipalId: `human-${index}`,
  displayName: `Person ${index}`
});
const workspace = (
  index: number,
  extra?: { archivedAt?: string | null; membershipActive?: boolean }
) => ({
  workspaceId: `workspace-${index}`,
  displayName: `Workspace ${index}`,
  membershipActive: extra?.membershipActive ?? true,
  archivedAt: extra?.archivedAt ?? null
});
const agent: OperatorRemoteAgentView = {
  endpointId: "endpoint-a",
  hostId: "host-a",
  displayName: "Agent A",
  accessMode: "workspace_restricted",
  ownerHumanPrincipalId: "human-a",
  ownershipRepairRequired: false,
  policyRevision: 3,
  revokedAt: null,
  grants: [{ workspaceId: "workspace-foreign", grantRevision: 4 }]
};

beforeEach(() => {
  for (const spy of [
    spies.listMembers,
    spies.listPicker,
    spies.listProjects,
    spies.listCanvases,
    spies.listAgents,
    spies.setAccessMode,
    spies.grantWorkspace,
    spies.repairOwnership,
    spies.getSelf,
    spies.getConnection
  ])
    spy.mockReset();
  spies.status.activeProfileId = "collab-a";
  spies.status.profiles[0].profileId = "collab-a";
  spies.status.profiles[0].humanPrincipalId = "human-a";
  spies.status.profiles[0].credentialRevision = "collab-revision-a";
  spies.status.workspaceConnection.workspaceId = "workspace-a";
  spies.status.workspaceConnection.status = "connected";
  spies.status.workspaceConnection.profile = {
    profileId: "workspace-profile-a",
    serverBaseUrl: "https://server.example/"
  };
  spies.status.workspaceConnection.credentialRevision = "credential-a";
  spies.owner.operatorProfileId = "operator-a";
  spies.owner.humanPrincipalId = "human-a";
  spies.owner.status.profiles[0].serverBaseUrl = "https://server.example/";
  spies.owner.status.profiles[0].hasOperatorCredential = true;
  spies.owner.status.profiles[0].credentialRevision = "revision-a";
  spies.listMembers.mockResolvedValue({ items: [], nextCursor: null });
  spies.listPicker.mockResolvedValue({ items: [], nextCursor: null });
  spies.getSelf.mockImplementation(() =>
    Promise.resolve({
      humanPrincipalId:
        spies.status.workspaceConnection.profile.profileId === "workspace-profile-b"
          ? "human-b"
          : "human-a",
      workspaceId: spies.status.workspaceConnection.workspaceId,
      deviceSessionId: "device-a"
    })
  );
  spies.getConnection.mockImplementation(() =>
    Promise.resolve({
      ...spies.status.workspaceConnection,
      profile: spies.status.workspaceConnection.profile
        ? { ...spies.status.workspaceConnection.profile }
        : null
    })
  );
  spies.listAgents.mockResolvedValue({ items: [agent] });
});
afterEach(cleanup);

describe("Remote Agent management catalog pagination", () => {
  it("loads the 101st person and Workspace only after explicit next-page requests", async () => {
    spies.status.workspaceConnection.workspaceId = "workspace-100";
    spies.listMembers.mockImplementation(({ cursor }: { cursor: number }) =>
      Promise.resolve(
        cursor === 0
          ? { items: Array.from({ length: 100 }, (_, index) => member(index)), nextCursor: 100 }
          : { items: [member(100)], nextCursor: null }
      )
    );
    spies.listPicker.mockImplementation(({ cursor }: { cursor: number }) =>
      Promise.resolve(
        cursor === 0
          ? { items: Array.from({ length: 100 }, (_, index) => workspace(index)), nextCursor: 100 }
          : { items: [workspace(100)], nextCursor: null }
      )
    );
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(result.current.people).toHaveLength(100));
    expect(result.current.workspaces).toHaveLength(100);
    expect(spies.listMembers).toHaveBeenCalledOnce();
    expect(spies.listPicker).toHaveBeenCalledOnce();
    await act(async () => {
      await result.current.loadMorePeople();
      await result.current.loadMoreWorkspaces();
    });
    expect(result.current.people.map((item) => item.humanPrincipalId)).toContain("human-100");
    expect(result.current.workspaces.map((item) => item.workspaceId)).toContain("workspace-100");
    expect(
      result.current.workspaces.find(
        (item) => item.workspaceId === spies.status.workspaceConnection.workspaceId
      )
    ).toBeDefined();
    expect(result.current.peopleNextCursor).toBeNull();
    expect(result.current.workspacesNextCursor).toBeNull();
  });

  it("follows an empty page with an advancing cursor, deduplicates, and filters archived or lost membership", async () => {
    spies.listPicker.mockImplementation(({ cursor }: { cursor: number }) =>
      Promise.resolve(
        cursor === 0
          ? { items: [], nextCursor: 100 }
          : {
              items: [
                workspace(100),
                workspace(100),
                workspace(101, { archivedAt: "2030-01-01T00:00:00.000Z" }),
                workspace(102, { membershipActive: false })
              ],
              nextCursor: null
            }
      )
    );
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(result.current.workspacesNextCursor).toBe(100));
    expect(result.current.workspaces).toEqual([]);
    await act(async () => result.current.loadMoreWorkspaces());
    expect(result.current.workspaces).toEqual([
      { workspaceId: "workspace-100", displayName: "Workspace 100" }
    ]);
  });

  it.each([
    0, -1
  ])("reports a non-advancing cursor %i without presenting an empty successful directory", async (nextCursor) => {
    spies.listPicker.mockResolvedValue({ items: [], nextCursor });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() =>
      expect(result.current.workspacesError).toBe("remote_agent_catalog_cursor_invalid")
    );
    expect(result.current.workspacesNextCursor).toBeNull();
  });

  it("keeps page one when page two fails and retries from the failed cursor", async () => {
    spies.listPicker.mockImplementation(({ cursor }: { cursor: number }) =>
      cursor === 0
        ? Promise.resolve({ items: [workspace(0)], nextCursor: 100 })
        : spies.listPicker.mock.calls.length === 2
          ? Promise.reject(new Error("operator_offline"))
          : Promise.resolve({ items: [workspace(100)], nextCursor: null })
    );
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(result.current.workspacesNextCursor).toBe(100));
    await act(async () => result.current.loadMoreWorkspaces());
    expect(result.current.workspacesError).toBe("operator_offline");
    expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-0"]);
    await act(async () => result.current.retryWorkspaces());
    expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual([
      "workspace-0",
      "workspace-100"
    ]);
    expect(spies.listPicker.mock.calls.map(([query]) => query.cursor)).toEqual([0, 100, 100]);
  });

  it("keeps the newest same-identity retry when responses arrive in reverse order", async () => {
    const first = deferred<{ items: ReturnType<typeof workspace>[]; nextCursor: null }>();
    const second = deferred<{ items: ReturnType<typeof workspace>[]; nextCursor: null }>();
    spies.listPicker.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(spies.listPicker).toHaveBeenCalledOnce());
    let retry!: Promise<void>;
    act(() => {
      retry = result.current.retryWorkspaces();
    });
    await act(async () => second.resolve({ items: [workspace(2)], nextCursor: null }));
    await act(async () => first.resolve({ items: [workspace(1)], nextCursor: null }));
    await retry;
    expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-2"]);
  });

  it("invalidates a late page after closing, then starts a fresh request on reopen", async () => {
    const first = deferred<{ items: ReturnType<typeof workspace>[]; nextCursor: null }>();
    spies.listPicker
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ items: [workspace(2)], nextCursor: null });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(spies.listPicker).toHaveBeenCalledOnce());
    act(() => result.current.releaseCatalog());
    await act(async () => first.resolve({ items: [workspace(1)], nextCursor: null }));
    expect(result.current.workspaces).toEqual([]);
    act(() => result.current.acquireCatalog());
    await waitFor(() =>
      expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-2"])
    );
  });

  it("ignores A's late response across A to B to A identity changes", async () => {
    const oldA = deferred<{ items: ReturnType<typeof workspace>[]; nextCursor: null }>();
    spies.listPicker
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce({ items: [workspace(2)], nextCursor: null })
      .mockResolvedValueOnce({ items: [workspace(3)], nextCursor: null });
    const { result, rerender } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(spies.listPicker).toHaveBeenCalledOnce());
    spies.status.workspaceConnection.workspaceId = "workspace-b";
    rerender();
    await waitFor(() =>
      expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-2"])
    );
    spies.status.workspaceConnection.workspaceId = "workspace-a";
    rerender();
    await waitFor(() =>
      expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-3"])
    );
    await act(async () => oldA.resolve({ items: [workspace(1)], nextCursor: null }));
    expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-3"]);
  });

  it("invalidates a late response when owner Human and Operator profile switch", async () => {
    const oldA = deferred<{ items: ReturnType<typeof workspace>[]; nextCursor: null }>();
    spies.listPicker
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce({ items: [workspace(2)], nextCursor: null })
      .mockResolvedValueOnce({ items: [workspace(3)], nextCursor: null });
    const { result, rerender } = renderHook(
      ({ ownerIdentity }) => useRemoteAgentCatalog(ownerIdentity),
      {
        initialProps: { ownerIdentity: owner }
      }
    );
    act(() => result.current.acquireCatalog());
    await waitFor(() => expect(spies.listPicker).toHaveBeenCalledOnce());
    spies.status.activeProfileId = "collab-b";
    spies.status.profiles[0].profileId = "collab-b";
    spies.status.profiles[0].humanPrincipalId = "human-b";
    spies.status.workspaceConnection.profile.profileId = "workspace-profile-b";
    rerender({
      ownerIdentity: {
        operatorProfileId: "operator-b",
        humanPrincipalId: "human-b",
        serverBaseUrl: owner.serverBaseUrl
      }
    });
    await waitFor(() =>
      expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-2"])
    );
    spies.status.activeProfileId = "collab-a";
    spies.status.profiles[0].profileId = "collab-a";
    spies.status.profiles[0].humanPrincipalId = "human-a";
    spies.status.workspaceConnection.profile.profileId = "workspace-profile-a";
    rerender({ ownerIdentity: owner });
    await waitFor(() =>
      expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-3"])
    );
    await act(async () => oldA.resolve({ items: [workspace(1)], nextCursor: null }));
    expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-3"]);
  });

  it("shows an identity error without querying another Human's catalog", async () => {
    spies.status.profiles[0].humanPrincipalId = "human-other";
    spies.getSelf.mockResolvedValue({
      humanPrincipalId: "human-other",
      workspaceId: "workspace-a",
      deviceSessionId: "device-other"
    });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() =>
      expect(result.current.workspacesError).toBe("remote_agent_catalog_identity_unavailable")
    );
    expect(result.current.peopleError).toBe("remote_agent_catalog_identity_unavailable");
    expect(spies.listMembers).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it("allows a different Collaboration profile for the same Human and Server", async () => {
    spies.status.activeProfileId = "collab-other-device";
    spies.status.profiles[0].profileId = "collab-other-device";
    spies.listPicker.mockResolvedValue({ items: [workspace(7)], nextCursor: null });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog());
    await waitFor(() =>
      expect(result.current.workspaces).toEqual([
        { workspaceId: "workspace-7", displayName: "Workspace 7" }
      ])
    );
    expect(result.current.workspacesError).toBeNull();
    expect(spies.listPicker).toHaveBeenCalledOnce();
  });

  it("rejects a local-only Workspace connection even when the legacy session is connected", async () => {
    Object.assign(spies.status.workspaceConnection, {
      status: "local_only",
      profile: null,
      workspaceId: null
    });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog("workspaces"));
    await waitFor(() =>
      expect(result.current.workspacesError).toBe("remote_agent_catalog_identity_unavailable")
    );
    expect(spies.getSelf).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it("rejects a picker authenticated as another Human without showing its Workspace", async () => {
    spies.getSelf.mockResolvedValue({
      humanPrincipalId: "human-other",
      workspaceId: "workspace-a",
      deviceSessionId: "device-other"
    });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog("workspaces"));
    await waitFor(() =>
      expect(result.current.workspacesError).toBe("remote_agent_catalog_identity_unavailable")
    );
    expect(result.current.workspaces).toEqual([]);
    expect(spies.listPicker).not.toHaveBeenCalled();
    expect(spies.listMembers).not.toHaveBeenCalled();
  });

  it("rejects another Server origin before querying Workspace credentials", async () => {
    spies.status.workspaceConnection.profile.serverBaseUrl = "https://other.example/";
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog("workspaces"));
    await waitFor(() =>
      expect(result.current.workspacesError).toBe("remote_agent_catalog_identity_unavailable")
    );
    expect(spies.getSelf).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it("rejects a live Workspace connection that changed before picker authorization", async () => {
    spies.getConnection.mockResolvedValue({
      ...spies.status.workspaceConnection,
      profile: { profileId: "workspace-profile-other", serverBaseUrl: "https://server.example/" }
    });
    const { result } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog("workspaces"));
    await waitFor(() =>
      expect(result.current.workspacesError).toBe("remote_agent_catalog_identity_unavailable")
    );
    expect(spies.getSelf).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it("drops an old picker page when the same profile rotates credentials", async () => {
    const oldPage = deferred<{ items: ReturnType<typeof workspace>[]; nextCursor: null }>();
    spies.listPicker
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [workspace(9)], nextCursor: null });
    const { result, rerender } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog("workspaces"));
    await waitFor(() => expect(spies.listPicker).toHaveBeenCalledOnce());
    spies.status.workspaceConnection.credentialRevision = "credential-b";
    rerender();
    await waitFor(() =>
      expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-9"])
    );
    await act(async () => oldPage.resolve({ items: [workspace(1)], nextCursor: null }));
    expect(result.current.workspaces.map((item) => item.workspaceId)).toEqual(["workspace-9"]);
    expect(spies.getSelf).toHaveBeenCalledTimes(2);
  });

  it("drops an old member page when the Collaboration credential rotates", async () => {
    const oldPage = deferred<{ items: ReturnType<typeof member>[]; nextCursor: null }>();
    spies.listMembers
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [member(9)], nextCursor: null });
    const { result, rerender } = renderHook(() => useRemoteAgentCatalog(owner));
    act(() => result.current.acquireCatalog("people"));
    await waitFor(() => expect(spies.listMembers).toHaveBeenCalledOnce());
    spies.status.profiles[0].credentialRevision = "collab-revision-b";
    rerender();
    await waitFor(() =>
      expect(result.current.people.map((item) => item.humanPrincipalId)).toEqual(["human-9"])
    );
    await act(async () => oldPage.resolve({ items: [member(1)], nextCursor: null }));
    expect(result.current.people.map((item) => item.humanPrincipalId)).toEqual(["human-9"]);
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it.each([
    0, 100, 500
  ])("keeps the first-screen bridge budget constant with %i projects", async (projectCount) => {
    spies.listProjects.mockResolvedValue({
      items: Array.from({ length: projectCount }),
      nextCursor: null
    });
    const { result } = renderHook(() => useRemoteAgentManagementController());
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    expect(spies.listAgents).toHaveBeenCalledOnce();
    expect(spies.listMembers).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
    expect(spies.listProjects).not.toHaveBeenCalled();
    expect(spies.listCanvases).not.toHaveBeenCalled();
  });

  it.each([
    "Server",
    "credential"
  ])("invalidates an old inventory response when one Operator profile changes %s", async (change) => {
    const oldList = deferred<{ items: OperatorRemoteAgentView[] }>();
    spies.listAgents.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce({
      items: [{ ...agent, endpointId: "endpoint-new", displayName: "New Server Agent" }]
    });
    const { result, rerender } = renderHook(() => useRemoteAgentManagementController());
    await waitFor(() => expect(spies.listAgents).toHaveBeenCalledOnce());
    if (change === "Server") spies.owner.status.profiles[0].serverBaseUrl = "https://new.example/";
    else spies.owner.status.profiles[0].credentialRevision = "revision-b";
    rerender();
    await waitFor(() =>
      expect(result.current.agents.map((item) => item.endpointId)).toEqual(["endpoint-new"])
    );
    await act(async () => oldList.resolve({ items: [agent] }));
    expect(result.current.agents.map((item) => item.endpointId)).toEqual(["endpoint-new"]);
    expect(spies.listAgents).toHaveBeenCalledTimes(2);
  });

  it("clears an old inventory and rejects a late mutation after credential removal", async () => {
    const oldMutation = deferred<OperatorRemoteAgentView>();
    spies.setAccessMode.mockReturnValue(oldMutation.promise);
    const { result, rerender } = renderHook(() => useRemoteAgentManagementController());
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.setAccessMode("endpoint-a", "unrestricted");
    });
    spies.owner.status.profiles[0].hasOperatorCredential = false;
    spies.owner.status.profiles[0].credentialRevision = null;
    rerender();
    await waitFor(() => expect(result.current.agents).toEqual([]));
    expect(result.current.error).toBe("operator_credential_missing");
    await act(async () => oldMutation.resolve({ ...agent, accessMode: "unrestricted" }));
    expect(await pending).toBe(false);
    expect(result.current.agents).toEqual([]);
    expect(spies.listAgents).toHaveBeenCalledOnce();
  });

  it("updates one Agent after a mutation without rereading the directory or inventory", async () => {
    spies.setAccessMode.mockResolvedValue({
      ...agent,
      accessMode: "unrestricted",
      policyRevision: 4
    });
    const { result } = renderHook(() => useRemoteAgentManagementController());
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    await act(async () => {
      expect(await result.current.setAccessMode("endpoint-a", "unrestricted")).toBe(true);
    });
    expect(spies.setAccessMode).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPolicyRevision: 3 })
    );
    expect(result.current.agents[0].policyRevision).toBe(4);
    expect(spies.listAgents).toHaveBeenCalledOnce();
    expect(spies.listMembers).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it("surfaces a grant revision conflict and refreshes only inventory on explicit retry", async () => {
    spies.grantWorkspace.mockRejectedValue(new Error("remote_agent_grant_revision_conflict"));
    const { result } = renderHook(() => useRemoteAgentManagementController());
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    await act(async () => {
      expect(await result.current.grantWorkspace("endpoint-a", "workspace-foreign")).toBe(false);
    });
    expect(spies.grantWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGrantRevision: 4 })
    );
    expect(result.current.actionError).toBe("remote_agent_grant_revision_conflict");
    await act(async () => result.current.retryAction());
    expect(spies.listAgents).toHaveBeenCalledTimes(2);
    expect(spies.listMembers).not.toHaveBeenCalled();
    expect(spies.listPicker).not.toHaveBeenCalled();
  });

  it("removes an Agent after owner repair assigns another Human", async () => {
    spies.repairOwnership.mockResolvedValue({
      ...agent,
      ownerHumanPrincipalId: "human-b",
      ownershipRepairRequired: false
    });
    const { result } = renderHook(() => useRemoteAgentManagementController());
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    await act(async () => {
      expect(await result.current.repairOwnership("endpoint-a", "human-b")).toBe(true);
    });
    expect(result.current.agents).toEqual([]);
    expect(spies.listAgents).toHaveBeenCalledOnce();
  });
});
