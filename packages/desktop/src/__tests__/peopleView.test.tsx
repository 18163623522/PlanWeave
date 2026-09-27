/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { formatPeoplePanelError, PeopleView } from "../renderer/views/PeopleView";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const { useOperatorControlStatusSnapshot } = vi.hoisted(() => ({
  useOperatorControlStatusSnapshot: vi.fn()
}));

vi.mock("../renderer/hooks/useOperatorControlStatusSnapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderer/hooks/useOperatorControlStatusSnapshot")>()),
  useOperatorControlStatusSnapshot
}));
vi.mock("../renderer/hooks/useMemberSetupCode", () => ({
  useMemberSetupCode: (_snapshot: unknown, target: unknown) => ({
    busy: false,
    identity: JSON.stringify(target),
    copy: async () => Boolean(await idleHostController.copyMemberSetupCode(target))
  })
}));

const idleHostController = {
  activeProfile: null,
  busy: false,
  copyMemberSetupCode: vi.fn().mockResolvedValue(null),
  dismissMemberSetupCodeHandoff: vi.fn(),
  memberSetupCodeHandoff: null
};

import { peopleIdentityReads } from "./helpers/peopleViewFixtures";

const scopeLayout = { collapsed: true, expandedProjectIds: [] };
const onScopeLayoutChange = () => undefined;

beforeEach(() => {
  useOperatorControlStatusSnapshot.mockReset();
  useOperatorControlStatusSnapshot.mockReturnValue(idleHostController);
});

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView", () => {
  it("localizes structured People rate limits without Electron IPC text", () => {
    const message = formatPeoplePanelError(createTranslator("zh-CN"), {
      kind: "rate_limited",
      code: "human_rate_limited",
      message:
        "Error invoking remote method 'planweave-collaboration:listInvitations': human_rate_limited",
      httpStatus: 429,
      retryAfterMs: 2_000,
      retryable: true
    });

    expect(message).toBe("协作请求过于频繁。请稍候再试。");
    expect(message).not.toContain("Error invoking remote method");
    expect(message).not.toContain("listInvitations");
  });

  it("keeps People network failures visible and adds the raw IPC text in developer mode", () => {
    const t = createTranslator("zh-CN");
    const ipcError = new Error(
      "Error invoking remote method 'planweave-collaboration:listCollaborationDevices': CollaborationClientError: Network request failed."
    );
    const structured = {
      kind: "offline",
      code: "collaboration_offline",
      message: "Network request failed.",
      retryable: true
    };

    expect(formatPeoplePanelError(t, ipcError)).toBe("Network request failed.");
    expect(formatPeoplePanelError(t, structured)).toBe(
      "collaboration_offline: Network request failed."
    );
    expect(formatPeoplePanelError(t, ipcError, true)).toContain(
      "Error invoking remote method 'planweave-collaboration:listCollaborationDevices'"
    );
    expect(formatPeoplePanelError(t, structured, true)).toBe(
      "collaboration_offline: Network request failed."
    );
  });

  it("keeps the connected workspace visible during a transient disconnected status event", async () => {
    let emitStatus: ((status: unknown) => void) | null = null;
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "https://collaboration.example.test",
          projectId: "project-1",
          allowInsecureTransport: false,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: "profile-1",
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Team",
          serverBaseUrl: "http://127.0.0.1:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus),
      onCollaborationStatusChanged: vi.fn((listener: (status: unknown) => void) => {
        emitStatus = listener;
        return () => undefined;
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("people-section-nav")).not.toBeInTheDocument();

    emitStatus?.({
      ...connectedStatus,
      session: { ...connectedStatus.session, phase: "idle" },
      workspaceConnection: { ...connectedStatus.workspaceConnection, status: "disconnected" },
      updatedAt: "2030-01-01T00:00:01.000Z"
    });

    await waitFor(() => expect(screen.getByTestId("people-workspace-section")).toBeVisible());
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("keeps a newer configured status when the initial status request finishes late", async () => {
    let emitStatus: ((status: CollaborationStatus) => void) | null = null;
    let resolveInitialStatus: ((status: CollaborationStatus) => void) | null = null;
    const localOnlyStatus = {
      profiles: [],
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } satisfies CollaborationStatus;
    const configuredStatus = {
      ...localOnlyStatus,
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Local workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      activeProfileId: "profile-1",
      session: { ...localOnlyStatus.session, activeProfileId: "profile-1" },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "disconnected",
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-1",
          displayName: "Local workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          workspaceId: "workspace-1",
          allowInsecureTransport: true
        },
        workspaceId: "workspace-1",
        workspaceDisplayName: "Local workspace",
        connectedAt: null,
        error: null
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    } satisfies CollaborationStatus;
    const api = {
      getCollaborationStatus: vi.fn(
        () =>
          new Promise<CollaborationStatus>((resolve) => {
            resolveInitialStatus = resolve;
          })
      ),
      onCollaborationStatusChanged: vi.fn((listener: (status: CollaborationStatus) => void) => {
        emitStatus = listener;
        return () => undefined;
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );
    await waitFor(() => expect(api.onCollaborationStatusChanged).toHaveBeenCalledOnce());

    act(() => emitStatus?.(configuredStatus));
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();

    await act(async () => resolveInitialStatus?.(localOnlyStatus));
    expect(screen.getByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("does not flash first-time onboarding while persisted collaboration status is loading", () => {
    const api = {
      getCollaborationStatus: vi.fn(() => new Promise(() => undefined)),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn(() => new Promise(() => undefined))
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Working");
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("shows a progressive create-or-join entry before a workspace is connected", () => {
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByTestId("people-view")).toHaveAccessibleName("Project members");
    expect(screen.getByTestId("people-view")).not.toHaveClass("border");
    expect(screen.getByTestId("people-view")).toHaveClass("[scrollbar-gutter:stable]");
    expect(screen.queryByRole("heading", { name: "Project people" })).not.toBeInTheDocument();
    expect(screen.getByTestId("collaboration-workspace-onboarding")).toBeInTheDocument();
    expect(screen.getByTestId("collaboration-onboarding-create")).toHaveTextContent(
      "Create a collaboration workspace"
    );
    expect(screen.getByTestId("collaboration-onboarding-join")).toHaveTextContent(
      "Join a collaboration workspace"
    );
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-section-hosting")).not.toBeInTheDocument();
  });

  it("reveals only the selected create or join flow", async () => {
    const user = userEvent.setup();
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(screen.getByTestId("collaboration-onboarding-create"));
    expect(screen.getByTestId("collaboration-onboarding-host-locally")).toBeVisible();
    expect(screen.getByTestId("collaboration-onboarding-existing-server")).toBeVisible();
    expect(screen.queryByTestId("people-connect-form")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("collaboration-onboarding-existing-server"));
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
    expect(screen.getByTestId("people-connect-setup-details")).toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-mode-join")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByTestId("collaboration-onboarding-join"));
    expect(screen.getByTestId("people-connect-invitation-details")).toBeVisible();
    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-project-id")).not.toBeInTheDocument();
  });

  it("leaves local hosting onboarding after workspace connection succeeds", async () => {
    const user = userEvent.setup();
    const localOnlyStatus = {
      profiles: [],
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const connectedStatus = {
      ...localOnlyStatus,
      profiles: [
        {
          profileId: "planweave-local-project-1",
          displayName: "Project One",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted" as const,
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      activeProfileId: "planweave-local-project-1",
      session: {
        phase: "connected" as const,
        activeProfileId: "planweave-local-project-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        ...localOnlyStatus.workspaceConnection,
        status: "connected" as const,
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Local workspace",
        connectedAt: "2030-01-01T00:00:01.000Z"
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    };
    const getCollaborationStatus = vi
      .fn()
      .mockResolvedValueOnce(localOnlyStatus)
      .mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local collaboration server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:56584/"
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "project-1",
            name: "Project One",
            selectedCanvasCount: 1,
            canvases: [
              {
                canvasId: "canvas-1",
                name: "Canvas One",
                selected: true,
                current: true
              }
            ]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" }
        ]),
      ...peopleIdentityReads()
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(await screen.findByTestId("collaboration-onboarding-create"));
    await user.click(screen.getByTestId("collaboration-onboarding-host-locally"));

    await waitFor(() => expect(getCollaborationStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-collaboration-server-panel")).not.toBeInTheDocument();
  });

  it("hides remote content authority while the project is local only", () => {
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.queryByTestId("content-authority-panel")).not.toBeInTheDocument();
  });
});
