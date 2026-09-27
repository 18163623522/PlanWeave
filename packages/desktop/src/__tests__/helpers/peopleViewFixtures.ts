import { vi } from "vitest";

export function peopleIdentityReads() {
  const workspaceSelf = {
    schemaVersion: "workspace-setup/v1" as const,
    workspaceId: "workspace-1",
    membershipId: "membership-1",
    humanPrincipalId: "human-1",
    displayName: "Ada Member",
    role: "member" as const,
    deviceSessionId: "device-session-1"
  };
  return {
    listCollaborationAuthorizedProjects: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationAuthorizedCanvases: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([]),
    listCollaborationMembers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationDevices: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationInvitations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getWorkspaceConnectionSelf: vi.fn().mockResolvedValue(workspaceSelf),
    updateWorkspaceConnectionSelf: vi
      .fn()
      .mockImplementation(async (input: { displayName: string }) => ({
        ...workspaceSelf,
        displayName: input.displayName
      })),
    listWorkspaceConnectionMembers: vi.fn().mockResolvedValue({
      schemaVersion: "workspace-setup/v1",
      items: [
        {
          schemaVersion: "workspace-setup/v1",
          membershipId: "membership-1",
          humanPrincipalId: "human-1",
          displayName: "Ada Member",
          role: "member",
          devices: [
            {
              schemaVersion: "workspace-setup/v1",
              deviceSessionId: "device-session-1",
              humanPrincipalId: "human-1",
              issuedAt: "2030-01-01T00:00:00.000Z",
              lastUsedAt: "2030-01-02T00:00:00.000Z",
              isCurrentDevice: true
            }
          ]
        }
      ],
      nextCursor: null
    })
  };
}
