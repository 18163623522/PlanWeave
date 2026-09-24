/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { ExecutorInventory } from "../renderer/executors/ExecutorInventory";
import { useRemoteAgentManagementController } from "../renderer/hooks/useRemoteAgentManagementController";
import { RemoteAgentManagementCard } from "../renderer/settings/RemoteAgentManagementCard";
import { createTranslator } from "../renderer/i18n";
import { hostAdministrationErrorCode } from "../renderer/settings/hostAdministrationErrors";
import type { OperatorRemoteAgentView } from "../shared/operatorControl";

const mocks = vi.hoisted(() => ({
  listOperatorRemoteAgents: vi.fn(),
  listCollaborationMembers: vi.fn(),
  listWorkspacePicker: vi.fn(),
  getSelf: vi.fn(),
  getConnection: vi.fn(),
  ownerSubscribe: vi.fn(),
  ownerUnsubscribe: vi.fn(),
  collaborationStatus: {
    activeProfileId: "collab-1",
    profiles: [
      {
        profileId: "collab-1",
        serverBaseUrl: "https://server.example/",
        humanPrincipalId: "human-1"
      }
    ],
    session: { phase: "connected" },
    workspaceConnection: {
      status: "connected",
      workspaceId: "workspace-1",
      credentialRevision: "credential-1",
      profile: { profileId: "workspace-profile-1", serverBaseUrl: "https://server.example/" }
    }
  },
  owner: {
    humanPrincipalId: "human-1",
    operatorProfileId: "profile-1",
    status: {
      profiles: [
        {
          profileId: "profile-1",
          serverBaseUrl: "https://server.example/",
          hasOperatorCredential: true,
          credentialRevision: "revision-1"
        }
      ]
    }
  }
}));

vi.mock("../renderer/bridge", () => ({
  operatorControlBridge: { listOperatorRemoteAgents: mocks.listOperatorRemoteAgents },
  collaborationBridge: {
    listCollaborationMembers: mocks.listCollaborationMembers,
    listWorkspacePicker: mocks.listWorkspacePicker,
    getWorkspaceConnectionSelf: mocks.getSelf,
    getActiveWorkspaceConnection: mocks.getConnection
  }
}));
vi.mock("../renderer/hooks/useOwnerControlPlaneAvailability", () => ({
  useOwnerControlPlaneAvailability: () => {
    useEffect(() => {
      mocks.ownerSubscribe();
      return () => mocks.ownerUnsubscribe();
    }, []);
    return mocks.owner;
  }
}));
vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: mocks.collaborationStatus,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}));

beforeEach(() => {
  mocks.listOperatorRemoteAgents.mockReset();
  mocks.listCollaborationMembers.mockReset();
  mocks.listWorkspacePicker.mockReset();
  mocks.getSelf.mockReset();
  mocks.getConnection.mockReset();
  mocks.ownerSubscribe.mockClear();
  mocks.ownerUnsubscribe.mockClear();
  mocks.listCollaborationMembers.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listWorkspacePicker.mockResolvedValue({ items: [], nextCursor: null });
  mocks.collaborationStatus.activeProfileId = "collab-1";
  mocks.collaborationStatus.workspaceConnection.workspaceId = "workspace-1";
  mocks.collaborationStatus.workspaceConnection.status = "connected";
  mocks.collaborationStatus.workspaceConnection.profile = {
    profileId: "workspace-profile-1",
    serverBaseUrl: "https://server.example/"
  };
  mocks.collaborationStatus.workspaceConnection.credentialRevision = "credential-1";
  mocks.owner.status.profiles[0].hasOperatorCredential = true;
  mocks.owner.status.profiles[0].credentialRevision = "revision-1";
  mocks.getSelf.mockResolvedValue({
    humanPrincipalId: "human-1",
    workspaceId: "workspace-1",
    deviceSessionId: "device-1"
  });
  mocks.getConnection.mockImplementation(() =>
    Promise.resolve({
      ...mocks.collaborationStatus.workspaceConnection,
      profile: mocks.collaborationStatus.workspaceConnection.profile
        ? { ...mocks.collaborationStatus.workspaceConnection.profile }
        : null
    })
  );
});
afterEach(cleanup);

const remoteAgent: OperatorRemoteAgentView = {
  endpointId: "endpoint-1",
  hostId: "host-1",
  displayName: "Remote Codex",
  accessMode: "workspace_restricted",
  ownershipRepairRequired: false,
  ownerHumanPrincipalId: "human-1",
  policyRevision: 1,
  revokedAt: null,
  grants: [{ workspaceId: "workspace-existing", grantRevision: 1 }]
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function Inventory() {
  const remote = useRemoteAgentManagementController();
  return (
    <ExecutorInventory
      agents={[]}
      transport="cli"
      hosts={[
        {
          id: "host-1",
          displayName: "Build Host",
          capabilities: ["codex"],
          capacity: 1,
          online: true,
          availability: { status: "available", reason: null }
        }
      ]}
      remote={remote}
      policy={remote}
      refreshing={false}
      onRefresh={vi.fn()}
      onConfigure={vi.fn()}
      t={createTranslator("en")}
    />
  );
}

describe("Remote Agent management failures", () => {
  it("loads the inventory before any management directory request", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    render(<Inventory />);
    expect(await screen.findByText("Remote Codex")).toBeVisible();
    expect(screen.getByTestId("executor-remote-row")).toHaveTextContent("Device online");
    expect(mocks.listCollaborationMembers).not.toHaveBeenCalled();
    expect(mocks.listWorkspacePicker).not.toHaveBeenCalled();
    expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce();
  });

  it("keeps a ready inventory when directory loading fails, and retries only the directory", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    mocks.listWorkspacePicker.mockRejectedValueOnce(new Error("operator_offline"));
    render(<Inventory />);
    await screen.findByText("Remote Codex");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByTestId("remote-agent-catalog-error")).toBeVisible();
    expect(screen.getByTestId("executor-remote-row")).toHaveTextContent("Device online");
    expect(screen.getByRole("switch", { name: "workspace-existing" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() =>
      expect(screen.queryByTestId("remote-agent-catalog-error")).not.toBeInTheDocument()
    );
    expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce();
    expect(mocks.listCollaborationMembers).not.toHaveBeenCalled();
    expect(mocks.listWorkspacePicker).toHaveBeenCalledTimes(2);
  });

  it("keeps a ready inventory when the Workspace picker fails", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    mocks.listWorkspacePicker.mockRejectedValue(new Error("operator_offline"));
    render(<Inventory />);
    await screen.findByText("Remote Codex");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByTestId("remote-agent-catalog-error")).toBeVisible();
    expect(screen.getByTestId("executor-remote-row")).toHaveTextContent("Device online");
    expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce();
  });

  it("keeps an existing grant visible when Workspace connection is local only", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    Object.assign(mocks.collaborationStatus.workspaceConnection, {
      status: "local_only",
      profile: null,
      workspaceId: null
    });
    render(<Inventory />);
    await screen.findByText("Remote Codex");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByTestId("remote-agent-catalog-error")).toHaveTextContent(
      "Connect a Workspace profile for this Agent owner and Server"
    );
    expect(screen.getByRole("switch", { name: "workspace-existing" })).toBeChecked();
    expect(screen.getByTestId("executor-remote-row")).toHaveTextContent("Device online");
    expect(mocks.getSelf).not.toHaveBeenCalled();
    expect(mocks.listWorkspacePicker).not.toHaveBeenCalled();
    expect(mocks.listCollaborationMembers).not.toHaveBeenCalled();
  });

  it("rechecks a transient live Workspace mismatch when the user retries with the same status identity", async () => {
    const firstConnection = deferred<typeof mocks.collaborationStatus.workspaceConnection>();
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    mocks.getConnection.mockReturnValueOnce(firstConnection.promise);
    mocks.listWorkspacePicker.mockResolvedValue({
      items: [
        {
          workspaceId: "workspace-new",
          displayName: "New Workspace",
          membershipActive: true,
          archivedAt: null
        }
      ],
      nextCursor: null
    });
    render(<Inventory />);
    await screen.findByText("Remote Codex");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(mocks.getConnection).toHaveBeenCalledOnce());
    await act(async () =>
      firstConnection.resolve({
        ...mocks.collaborationStatus.workspaceConnection,
        workspaceId: "workspace-other"
      })
    );
    expect(await screen.findByTestId("remote-agent-catalog-error")).toHaveTextContent(
      "Connect a Workspace profile for this Agent owner and Server"
    );
    expect(screen.getByRole("switch", { name: "workspace-existing" })).toBeChecked();
    expect(mocks.listWorkspacePicker).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry options" }));
    expect(await screen.findByRole("switch", { name: "New Workspace" })).toBeVisible();
    expect(screen.queryByTestId("remote-agent-catalog-error")).not.toBeInTheDocument();
    expect(mocks.getConnection).toHaveBeenCalledTimes(2);
    expect(mocks.getSelf).toHaveBeenCalledOnce();
    expect(mocks.listWorkspacePicker).toHaveBeenCalledOnce();
    expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce();
  });

  it("loads the next Workspace page from the editor without rereading inventory", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    mocks.listWorkspacePicker.mockImplementation(({ cursor }: { cursor: number }) =>
      Promise.resolve(
        cursor === 0
          ? {
              items: [
                {
                  workspaceId: "workspace-first",
                  displayName: "First Workspace",
                  membershipActive: true,
                  archivedAt: null
                }
              ],
              nextCursor: 100
            }
          : {
              items: [
                {
                  workspaceId: "workspace-101",
                  displayName: "Workspace 101",
                  membershipActive: true,
                  archivedAt: null
                }
              ],
              nextCursor: null
            }
      )
    );
    render(<Inventory />);
    await screen.findByText("Remote Codex");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("switch", { name: "First Workspace" });
    await userEvent.click(screen.getByRole("button", { name: "Load more workspaces" }));
    expect(await screen.findByRole("switch", { name: "Workspace 101" })).toBeVisible();
    expect(mocks.listWorkspacePicker.mock.calls.map(([query]) => query.cursor)).toEqual([0, 100]);
    expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce();
  });

  it("shows a member-directory failure only in owner repair and retries without rereading inventory", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({
      items: [{ ...remoteAgent, ownershipRepairRequired: true }]
    });
    mocks.listCollaborationMembers.mockRejectedValueOnce(new Error("operator_offline"));
    render(<Inventory />);
    await screen.findByText("Remote Codex");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByTestId("remote-agent-catalog-error")).toHaveTextContent(
      "People options are unavailable"
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() =>
      expect(screen.queryByTestId("remote-agent-catalog-error")).not.toBeInTheDocument()
    );
    expect(mocks.listCollaborationMembers).toHaveBeenCalledTimes(2);
    expect(mocks.listWorkspacePicker).not.toHaveBeenCalled();
    expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce();
  });

  it("reports an inventory failure without loading the directory", async () => {
    mocks.listOperatorRemoteAgents.mockRejectedValue(new Error("operator_offline"));
    render(<Inventory />);
    expect(await screen.findByText(createTranslator("en")("hostAdminOffline"))).toBeVisible();
    expect(mocks.listCollaborationMembers).not.toHaveBeenCalled();
    expect(mocks.listWorkspacePicker).not.toHaveBeenCalled();
  });

  it("does not create an owned controller when one is injected", async () => {
    mocks.listOperatorRemoteAgents.mockResolvedValue({ items: [remoteAgent] });
    function InjectedCard() {
      const controller = useRemoteAgentManagementController();
      return <RemoteAgentManagementCard controller={controller} t={createTranslator("en")} />;
    }
    const injected = render(<InjectedCard />);
    await waitFor(() => expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce());
    expect(mocks.ownerSubscribe).toHaveBeenCalledOnce();
    injected.unmount();
    expect(mocks.ownerUnsubscribe).toHaveBeenCalledOnce();

    mocks.listOperatorRemoteAgents.mockClear();
    mocks.ownerSubscribe.mockClear();
    mocks.ownerUnsubscribe.mockClear();
    const owned = render(<RemoteAgentManagementCard t={createTranslator("en")} />);
    await waitFor(() => expect(mocks.listOperatorRemoteAgents).toHaveBeenCalledOnce());
    expect(mocks.ownerSubscribe).toHaveBeenCalledOnce();
    owned.unmount();
    expect(mocks.ownerUnsubscribe).toHaveBeenCalledOnce();
  });
  it.each([
    new Error("operator_unauthorized (server 8bac301aba331bc7642e4fa9799512016ccf5164)"),
    {
      name: "Error",
      message: "operator_unauthorized (server 8bac301aba331bc7642e4fa9799512016ccf5164)"
    }
  ])("preserves expired management access across the Electron error boundary", async (error) => {
    const t = createTranslator("zh-CN");
    mocks.listOperatorRemoteAgents.mockRejectedValue(error);
    render(<RemoteAgentManagementCard t={t} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("hostAdminUnauthorized"));
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(screen.queryByText(/8bac301|operator_unauthorized/)).not.toBeInTheDocument();
  });

  it.each([
    "operator_unauthorized_custom",
    "operator_unauthorized_custom (server revision)",
    "Error invoking remote method: operator_unauthorized_custom",
    "not_operator_unauthorized"
  ])("does not classify a different code as an authentication failure: %s", (message) => {
    expect(hostAdministrationErrorCode(new Error(message))).toBe("operator_request_failed");
  });

  it("keeps the local executor configurable when the remote Server is offline", async () => {
    mocks.listOperatorRemoteAgents.mockRejectedValue(new Error("operator_offline"));
    const configure = vi.fn();
    function Inventory() {
      const remote = useRemoteAgentManagementController();
      return (
        <ExecutorInventory
          agents={[
            {
              kind: "codex",
              runnerKind: "cli",
              name: "Codex",
              command: "codex",
              versionArgs: [],
              execArgs: [],
              fullAccessArgs: [],
              installed: true,
              version: null,
              unavailableReason: null
            }
          ]}
          transport="cli"
          hosts={[]}
          remote={remote}
          policy={remote}
          refreshing={false}
          onRefresh={vi.fn()}
          onConfigure={configure}
          t={createTranslator("en")}
        />
      );
    }
    render(<Inventory />);
    expect(screen.getByTestId("executor-local-row")).toHaveTextContent("Codex");
    expect(await screen.findByText(createTranslator("en")("hostAdminOffline"))).toBeVisible();
    expect(screen.queryByText(/operator_offline|Error invoking/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(configure).toHaveBeenCalledOnce();
  });

  it.each([
    ["operator_offline", "hostAdminOffline"],
    ["operator_timeout", "hostAdminOffline"],
    ["operator_unauthorized", "hostAdminUnauthorized"],
    ["unexpected database detail", "hostAdminErrorGeneric"]
  ] as const)("humanizes serialized IPC failure %s without a false empty list", async (code, key) => {
    const t = createTranslator("zh-CN");
    mocks.listOperatorRemoteAgents.mockRejectedValue(
      new Error(
        `Error invoking remote method 'planweave-operator:listRemoteAgents': OperatorControlError: ${code}`
      )
    );
    render(<RemoteAgentManagementCard t={t} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(t(key));
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Error invoking|OperatorControlError|operator_offline|database detail/)
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-refresh")).toBeEnabled();
  });

  it("shows an empty list only after a successful retry", async () => {
    const t = createTranslator("en");
    let resolve!: (value: { items: [] }) => void;
    mocks.listOperatorRemoteAgents
      .mockRejectedValueOnce(new Error("operator_offline"))
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
    render(<RemoteAgentManagementCard t={t} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByTestId("remote-agent-management-refresh"));
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-refresh")).toBeDisabled();
    await act(async () => resolve({ items: [] }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-empty")).toHaveTextContent(
      t("remoteAgentManagementEmpty")
    );
  });

  it("does not report an empty fleet while the first request is pending", () => {
    mocks.listOperatorRemoteAgents.mockImplementation(() => new Promise(() => {}));
    render(<RemoteAgentManagementCard t={createTranslator("en")} />);
    expect(screen.queryByTestId("remote-agent-management-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-agent-management-refresh")).toBeDisabled();
  });
});
