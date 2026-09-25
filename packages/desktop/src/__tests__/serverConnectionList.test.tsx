/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { activeWorkspaceConnectionViewSchema } from "@planweave-ai/collaboration-protocol/connection";
import { ServerConnectionList } from "../renderer/settings/ServerConnectionList";
import { createTranslator } from "../renderer/i18n";

const api = vi.hoisted(() => ({
  listRememberedServerConnections: vi.fn(),
  selectWorkspaceConnection: vi.fn().mockResolvedValue(undefined),
  validateDeploymentConnectivity: vi.fn().mockResolvedValue({ status: "reachable" })
}));
let connection = activeWorkspaceConnectionViewSchema.parse({
  schemaVersion: "workspace-setup/v1",
  status: "connected",
  profile: {
    schemaVersion: "workspace-identity/v1",
    profileId: "active",
    displayName: "Configured workspace",
    serverBaseUrl: "https://vps.example/",
    workspaceId: "team",
    allowInsecureTransport: false
  },
  workspaceId: "team",
  workspaceDisplayName: "Team",
  connectedAt: "2030-01-01T00:00:00.000Z",
  credentialRevision: "active-device-revision",
  error: null
});
const operatorControlBridge = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn().mockResolvedValue({
    activeProfileId: "admin",
    profiles: [{ profileId: "admin", operatorId: "owner", serverBaseUrl: "https://vps.example/" }]
  }),
  onOperatorControlStatusChanged: vi.fn(() => () => undefined),
  reauthorizeManagement: vi.fn(),
  getManagementAuthorization: vi.fn().mockResolvedValue({
    profileId: "admin",
    authorization: null,
    errorCode: "operator_management_recovery_required"
  })
}));
vi.mock("../renderer/bridge", () => ({ collaborationBridge: api, operatorControlBridge }));
vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: { workspaceConnection: connection },
    refresh: async () => undefined
  })
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function fixture(status: "connected" | "disconnected" = "connected") {
  connection = { ...connection, status };
  api.listRememberedServerConnections.mockResolvedValue(
    ["active", "other"].map((profileId) => ({
      profileId,
      displayName: "Configured workspace",
      workspaceDisplayName: "Team",
      serverBaseUrl: "https://vps.example/",
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://vps.example/",
        allowedClientOrigins: ["https://vps.example/"],
        tlsTrust: "system_ca"
      },
      hasDeviceCredential: true
    }))
  );
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
}
it("shows the destination host and marks the active saved connection without reconnecting it", async () => {
  fixture();
  expect(await screen.findByTestId("server-connection-row")).toHaveTextContent("vps.example");
  await userEvent.click(screen.getByRole("button", { name: /More actions/ }));
  expect(screen.getByRole("menuitem", { name: /Current connection/ })).toHaveAttribute(
    "data-disabled"
  );
  await userEvent.click(screen.getByRole("menuitem", { name: /Use connection.*other/ }));
  await waitFor(() =>
    expect(api.selectWorkspaceConnection).toHaveBeenCalledWith({ profileId: "other" })
  );
});
it("checks the Server without changing the selected Workspace connection", async () => {
  fixture();
  await screen.findByTestId("server-connection-row");
  await userEvent.click(screen.getByRole("button", { name: "Check connectivity" }));
  await waitFor(() => expect(api.validateDeploymentConnectivity).toHaveBeenCalledOnce());
  expect(api.validateDeploymentConnectivity.mock.calls[0]?.[0].target.endpoint.serverOrigin).toBe(
    "https://vps.example/"
  );
  expect(api.selectWorkspaceConnection).not.toHaveBeenCalled();
});

it("lets the user choose a saved connection before connecting a Server with multiple records", async () => {
  fixture("disconnected");
  await screen.findByTestId("server-connection-row");
  await userEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  expect(await screen.findByRole("menu")).toBeVisible();
  expect(api.selectWorkspaceConnection).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("menuitem", { name: /Use connection.*other/ }));
  await waitFor(() =>
    expect(api.selectWorkspaceConnection).toHaveBeenCalledExactlyOnceWith({ profileId: "other" })
  );
});
it("keeps a failed switch visible without replacing the active destination", async () => {
  api.selectWorkspaceConnection.mockRejectedValueOnce(
    new Error("The configured Server could not be reached.")
  );
  fixture();
  await screen.findByTestId("server-connection-row");
  await userEvent.click(screen.getByRole("button", { name: /More actions/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Use connection.*other/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    createTranslator("en")("peopleServerUnreachable")
  );
  expect(connection.profile?.profileId).toBe("active");
});

it.each([
  ["https://host.tailnet.ts.net/", "public_https", "Tailscale HTTPS (identified by address)"],
  ["https://ts.net.example.com/", "public_https", "HTTPS"],
  ["https://private.example/", "private_https", "Private network HTTPS"],
  ["http://192.168.1.2:8787/", "lan_http", "LAN HTTP (development only)"]
])("shows deployment information for %s and checks the stored endpoint", async (origin, topology, label) => {
  const endpoint = {
    topology,
    serverOrigin: origin,
    allowedClientOrigins: [origin],
    tlsTrust: origin.startsWith("https:") ? "system_ca" : "not_applicable"
  };
  connection = { ...connection, status: "connected" };
  api.listRememberedServerConnections.mockResolvedValue([
    {
      profileId: "active",
      displayName: "Team",
      workspaceDisplayName: "Team",
      serverBaseUrl: origin,
      endpoint,
      hasDeviceCredential: true
    }
  ]);
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  expect(await screen.findByTestId("server-deployment-method")).toHaveTextContent(label);
  await userEvent.click(screen.getByRole("button", { name: "Check connectivity" }));
  await waitFor(() => expect(api.validateDeploymentConnectivity).toHaveBeenCalledOnce());
  expect(api.validateDeploymentConnectivity.mock.calls[0]?.[0].target.endpoint).toEqual(endpoint);
  expect(api.selectWorkspaceConnection).not.toHaveBeenCalled();
});

it("offers recovery within the Server row without changing connection status", async () => {
  fixture();
  expect(await screen.findByText("Management access needs recovery")).toBeVisible();
  expect(screen.getByTestId("server-connection-row")).toHaveTextContent("Connected");
  await userEvent.click(screen.getByRole("button", { name: "Restore access" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("https://vps.example/");
  expect(screen.getByLabelText("One-time recovery code")).toBeVisible();
});

function remembered(profileId: string) {
  const serverBaseUrl = `https://${profileId}.example/`;
  return {
    profileId,
    displayName: profileId,
    workspaceDisplayName: profileId,
    serverBaseUrl,
    endpoint: {
      topology: "public_https",
      serverOrigin: serverBaseUrl,
      allowedClientOrigins: [serverBaseUrl],
      tlsTrust: "system_ca"
    },
    hasDeviceCredential: true
  };
}

it.each([1, 5, 20])("reads one full operator status for %i Server rows", async (count) => {
  const listeners = new Set<(status: unknown) => void>();
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const records = Array.from({ length: count + 1 }, (_, index) => remembered(`server-${index}`));
  api.listRememberedServerConnections.mockResolvedValue(records.slice(0, count));
  operatorControlBridge.getOperatorControlStatus.mockResolvedValue({
    activeProfileId: records[0].profileId,
    profiles: records.map((record) => ({
      profileId: record.profileId,
      operatorId: `operator-${record.profileId}`,
      serverBaseUrl: record.serverBaseUrl,
      hasOperatorCredential: true,
      operatorCredentialPersistence: "persisted",
      credentialRevision: `revision-${record.profileId}`
    }))
  });
  operatorControlBridge.getManagementAuthorization.mockImplementation(({ profileId }) =>
    Promise.resolve({ profileId, authorization: null, errorCode: "operator_offline" })
  );
  const view = render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  await waitFor(() => expect(screen.getAllByTestId("server-connection-row")).toHaveLength(count));
  await waitFor(() =>
    expect(operatorControlBridge.getManagementAuthorization).toHaveBeenCalledTimes(count)
  );
  expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(1);
  api.listRememberedServerConnections.mockResolvedValue(records);
  view.rerender(<ServerConnectionList refreshKey={1} t={createTranslator("en")} />);
  await waitFor(() =>
    expect(screen.getAllByTestId("server-connection-row")).toHaveLength(count + 1)
  );
  expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("keeps two lists and their subscriptions independent", async () => {
  const listeners = new Set<(status: unknown) => void>();
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  api.listRememberedServerConnections.mockResolvedValue([remembered("alpha")]);
  operatorControlBridge.getOperatorControlStatus.mockResolvedValue({
    activeProfileId: "alpha",
    profiles: [{ ...remembered("alpha"), operatorId: "admin", hasOperatorCredential: true }]
  });
  const first = render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  const second = render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  await waitFor(() =>
    expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(2)
  );
  expect(listeners.size).toBe(2);
  first.unmount();
  expect(listeners.size).toBe(1);
  second.unmount();
  expect(listeners.size).toBe(0);
});

it("retains one live subscription after StrictMode setup and cleanup", async () => {
  const listeners = new Set<(status: unknown) => void>();
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  api.listRememberedServerConnections.mockResolvedValue([remembered("alpha")]);
  const view = render(
    <StrictMode>
      <ServerConnectionList refreshKey={0} t={createTranslator("en")} />
    </StrictMode>
  );
  await screen.findByTestId("server-connection-row");
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("does not block another Server while one authorization check is slow or loses credentials", async () => {
  const records = [remembered("alpha"), remembered("beta")];
  const profiles = records.map((record) => ({
    profileId: record.profileId,
    operatorId: `operator-${record.profileId}`,
    serverBaseUrl: record.serverBaseUrl,
    hasOperatorCredential: true,
    operatorCredentialPersistence: "persisted",
    credentialRevision: `revision-${record.profileId}`
  }));
  let statusChanged!: (status: unknown) => void;
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return () => undefined;
  });
  operatorControlBridge.getOperatorControlStatus.mockResolvedValue({
    activeProfileId: "alpha",
    profiles
  });
  api.listRememberedServerConnections.mockResolvedValue(records);
  let finishAlpha!: (value: unknown) => void;
  const alphaCheck = new Promise((resolve) => {
    finishAlpha = resolve;
  });
  operatorControlBridge.getManagementAuthorization.mockImplementation(({ profileId }) =>
    profileId === "alpha"
      ? alphaCheck
      : Promise.resolve({
          profileId,
          authorization: { operatorId: "operator-beta" },
          errorCode: null
        })
  );
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  const rows = await screen.findAllByTestId("server-connection-row");
  await waitFor(() => expect(within(rows[1]).getByText("Administrator")).toBeVisible());
  expect(within(rows[0]).queryByText("Administrator")).not.toBeInTheDocument();
  await act(async () => {
    statusChanged({
      activeProfileId: "alpha",
      profiles: [
        { ...profiles[0], hasOperatorCredential: false, operatorCredentialPersistence: "missing" },
        profiles[1]
      ]
    });
  });
  await act(async () =>
    finishAlpha({
      profileId: "alpha",
      authorization: { operatorId: "operator-alpha" },
      errorCode: null
    })
  );
  expect(within(rows[0]).queryByText("Administrator")).not.toBeInTheDocument();
  expect(within(rows[1]).getByText("Administrator")).toBeVisible();
  expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(1);
});

it("keeps B authorized when A's status refresh fails", async () => {
  const records = [remembered("alpha"), remembered("beta")];
  operatorControlBridge.getOperatorControlStatus.mockReset();
  operatorControlBridge.getOperatorControlStatus
    .mockResolvedValueOnce({
      activeProfileId: "alpha",
      profiles: records.map((record) => ({
        profileId: record.profileId,
        operatorId: "admin",
        serverBaseUrl: record.serverBaseUrl,
        hasOperatorCredential: true,
        operatorCredentialPersistence: "persisted"
      }))
    })
    .mockRejectedValueOnce(new Error("operator_management_failed"));
  operatorControlBridge.getManagementAuthorization.mockImplementation(({ profileId }) =>
    Promise.resolve({
      profileId,
      authorization: profileId === "beta" ? { operatorId: "admin" } : null,
      errorCode: profileId === "alpha" ? "operator_management_recovery_required" : null
    })
  );
  operatorControlBridge.reauthorizeManagement.mockResolvedValue({
    profileId: "alpha",
    authorization: { operatorId: "admin" },
    errorCode: null
  });
  api.listRememberedServerConnections.mockResolvedValue(records);
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  const rows = await screen.findAllByTestId("server-connection-row");
  await waitFor(() => expect(within(rows[1]).getByText("Administrator")).toBeVisible());
  await userEvent.click(within(rows[0]).getByRole("button", { name: "Restore access" }));
  await userEvent.click(screen.getByRole("button", { name: "Try saved authorization" }));
  await waitFor(() =>
    expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(2)
  );
  expect(within(rows[1]).getByText("Administrator")).toBeVisible();
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeVisible();
});

it("keeps B authorized when a same-millisecond A conflict cannot be reread", async () => {
  const records = [remembered("alpha"), remembered("beta")];
  const initial = {
    activeProfileId: "alpha",
    updatedAt: "2030-01-01T00:00:00.001Z",
    profiles: records.map((record) => ({
      profileId: record.profileId,
      operatorId: "admin",
      serverBaseUrl: record.serverBaseUrl,
      hasOperatorCredential: true,
      operatorCredentialPersistence: "persisted",
      credentialRevision: `revision-${record.profileId}`
    }))
  };
  let statusChanged!: (status: typeof initial) => void;
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return () => undefined;
  });
  operatorControlBridge.getOperatorControlStatus
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("operator_management_failed"));
  operatorControlBridge.getManagementAuthorization.mockImplementation(({ profileId }) =>
    Promise.resolve({
      profileId,
      authorization: profileId === "beta" ? { operatorId: "admin" } : null,
      errorCode: profileId === "alpha" ? "operator_management_recovery_required" : null
    })
  );
  api.listRememberedServerConnections.mockResolvedValue(records);
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  const rows = await screen.findAllByTestId("server-connection-row");
  await waitFor(() => expect(within(rows[1]).getByText("Administrator")).toBeVisible());
  await act(async () =>
    statusChanged({
      ...initial,
      profiles: [
        { ...initial.profiles[0], credentialRevision: "conflicting-alpha" },
        initial.profiles[1]
      ]
    })
  );
  await waitFor(() =>
    expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(2)
  );
  expect(within(rows[1]).getByText("Administrator")).toBeVisible();
  expect(within(rows[0]).queryByText("Administrator")).not.toBeInTheDocument();
  expect(
    within(rows[0]).getByText(
      "Cannot check management access right now. Check the connection and retry."
    )
  ).toBeVisible();
});

it("does not keep A authorized when a same-millisecond active switch within its Server cannot be reread", async () => {
  const records = [remembered("alpha"), remembered("beta")];
  const initial = {
    activeProfileId: "alpha-a",
    updatedAt: "2030-01-01T00:00:00.001Z",
    profiles: [
      {
        profileId: "alpha-a",
        operatorId: "admin-a",
        serverBaseUrl: records[0].serverBaseUrl,
        hasOperatorCredential: true,
        operatorCredentialPersistence: "persisted",
        credentialRevision: "revision-a"
      },
      {
        profileId: "alpha-b",
        operatorId: "admin-b",
        serverBaseUrl: records[0].serverBaseUrl,
        hasOperatorCredential: true,
        operatorCredentialPersistence: "persisted",
        credentialRevision: "revision-b"
      },
      {
        profileId: "beta",
        operatorId: "admin-beta",
        serverBaseUrl: records[1].serverBaseUrl,
        hasOperatorCredential: true,
        operatorCredentialPersistence: "persisted",
        credentialRevision: "revision-beta"
      }
    ]
  };
  let statusChanged!: (status: typeof initial) => void;
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return () => undefined;
  });
  operatorControlBridge.getOperatorControlStatus
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("operator_management_failed"));
  operatorControlBridge.getManagementAuthorization.mockImplementation(({ profileId }) =>
    Promise.resolve({
      profileId,
      authorization: {
        operatorId: profileId === "beta" ? "admin-beta" : `admin-${profileId.slice(-1)}`
      },
      errorCode: null
    })
  );
  api.listRememberedServerConnections.mockResolvedValue(records);
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  const rows = await screen.findAllByTestId("server-connection-row");
  await waitFor(() => expect(within(rows[0]).getByText("Administrator")).toBeVisible());
  await waitFor(() => expect(within(rows[1]).getByText("Administrator")).toBeVisible());
  expect(operatorControlBridge.getManagementAuthorization).toHaveBeenCalledWith({
    profileId: "alpha-a"
  });
  await act(async () => statusChanged({ ...initial, activeProfileId: "alpha-b" }));
  await waitFor(() =>
    expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(2)
  );
  expect(within(rows[0]).queryByText("Administrator")).not.toBeInTheDocument();
  expect(
    within(rows[0]).getByText(
      "Cannot check management access right now. Check the connection and retry."
    )
  ).toBeVisible();
  expect(within(rows[1]).getByText("Administrator")).toBeVisible();
});

it.each([
  "before",
  "during"
])("attributes A's failed action refresh to A when only B publishes %s the refresh", async (eventTiming) => {
  const records = [remembered("alpha"), remembered("beta")];
  const initial = {
    activeProfileId: "alpha",
    updatedAt: "2030-01-01T00:00:00.001Z",
    profiles: records.map((record) => ({
      profileId: record.profileId,
      operatorId: "admin",
      serverBaseUrl: record.serverBaseUrl,
      hasOperatorCredential: true,
      operatorCredentialPersistence: "persisted",
      credentialRevision: `revision-${record.profileId}`
    }))
  };
  let statusChanged!: (status: typeof initial) => void;
  operatorControlBridge.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return () => undefined;
  });
  let failRefresh!: (reason: unknown) => void;
  operatorControlBridge.getOperatorControlStatus.mockResolvedValueOnce(initial).mockReturnValueOnce(
    new Promise((_, reject) => {
      failRefresh = reject;
    })
  );
  operatorControlBridge.getManagementAuthorization.mockImplementation(({ profileId }) =>
    Promise.resolve({
      profileId,
      authorization: profileId === "beta" ? { operatorId: "admin" } : null,
      errorCode: profileId === "alpha" ? "operator_management_recovery_required" : null
    })
  );
  let finishAction!: (view: {
    profileId: string;
    authorization: { operatorId: string };
    errorCode: null;
  }) => void;
  operatorControlBridge.reauthorizeManagement.mockReturnValue(
    new Promise((resolve) => {
      finishAction = resolve;
    })
  );
  api.listRememberedServerConnections.mockResolvedValue(records);
  render(<ServerConnectionList refreshKey={0} t={createTranslator("en")} />);
  const rows = await screen.findAllByTestId("server-connection-row");
  await waitFor(() => expect(within(rows[1]).getByText("Administrator")).toBeVisible());
  await userEvent.click(within(rows[0]).getByRole("button", { name: "Restore access" }));
  await userEvent.click(screen.getByRole("button", { name: "Try saved authorization" }));
  const updateB = async () =>
    act(async () =>
      statusChanged({
        ...initial,
        updatedAt: "2030-01-01T00:00:00.002Z",
        profiles: [
          initial.profiles[0],
          { ...initial.profiles[1], credentialRevision: "updated-beta" }
        ]
      })
    );
  if (eventTiming === "before") await updateB();
  await act(async () =>
    finishAction({
      profileId: "alpha",
      authorization: { operatorId: "admin" },
      errorCode: null
    })
  );
  await waitFor(() =>
    expect(operatorControlBridge.getOperatorControlStatus).toHaveBeenCalledTimes(2)
  );
  if (eventTiming === "during") await updateB();
  await act(async () => failRefresh(new Error("operator_management_failed")));
  expect(within(rows[1]).getByText("Administrator")).toBeVisible();
  expect(within(rows[0]).queryByText("Administrator")).not.toBeInTheDocument();
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeVisible();
  expect(screen.queryByText("Authorization verified")).not.toBeInTheDocument();
});
