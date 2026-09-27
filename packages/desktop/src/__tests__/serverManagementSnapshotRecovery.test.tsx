/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorControlStatus } from "../shared/operatorControl";
import type { OperatorManagementView } from "../shared/operatorManagement";
import { useOperatorControlStatusSnapshot } from "../renderer/hooks/useOperatorControlStatusSnapshot";
import { useServerManagementAuthorization } from "../renderer/hooks/useServerManagementAuthorization";

const api = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  getManagementAuthorization: vi.fn(),
  revokeManagementDevice: vi.fn(),
  onOperatorControlStatusChanged: vi.fn()
}));
vi.mock("../renderer/bridge", () => ({ operatorControlBridge: api }));
const initial: OperatorControlStatus = {
  activeProfileId: "a",
  credentialStorage: "available",
  nonPersistenceWarning: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  updatedAt: "2030-01-01T00:00:00.001Z",
  profiles: ["a", "b", "alternate"].map((profileId) => ({
    profileId,
    displayName: profileId,
    serverBaseUrl: `https://${profileId === "alternate" ? "a" : profileId}.example/`,
    allowInsecureTransport: false,
    hostedByThisDesktop: false,
    operatorId: profileId === "alternate" ? "alternate-admin" : "admin",
    humanPrincipalId: null,
    hasOperatorCredential: true,
    operatorCredentialPersistence: "persisted",
    credentialRevision: "r1",
    updatedAt: "2030-01-01T00:00:00.001Z"
  }))
};
const deviceId = "c28d8f73-0881-4a71-b21d-2a69f223aabc";
function authorized(profileId: string): OperatorManagementView {
  return {
    profileId,
    authorization: {
      operatorId: "admin",
      expiresAt: "2030-02-01T00:00:00Z",
      renewAfter: "2030-01-22T00:00:00Z"
    },
    errorCode: null,
    devices: [
      {
        deviceId,
        deviceName: `${profileId} device`,
        operatorId: "admin",
        createdAt: "2030-01-01T00:00:00Z",
        lastUsedAt: "2030-01-01T00:00:00Z",
        revokedAt: null
      }
    ]
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function changed(profileId: string, revision: string): OperatorControlStatus {
  return {
    ...initial,
    updatedAt: "2030-01-01T00:00:00.002Z",
    profiles: initial.profiles.map((profile) =>
      profile.profileId === profileId ? { ...profile, credentialRevision: revision } : profile
    )
  };
}
let statusChanged: (status: OperatorControlStatus) => void;
beforeEach(() => {
  vi.resetAllMocks();
  api.getOperatorControlStatus.mockResolvedValue(initial);
  api.getManagementAuthorization.mockImplementation(({ profileId }: { profileId: string }) =>
    Promise.resolve(authorized(profileId))
  );
  api.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusChanged = listener;
    return () => undefined;
  });
});
afterEach(cleanup);
async function load() {
  const hook = renderHook(() => {
    const snapshot = useOperatorControlStatusSnapshot();
    return {
      a: useServerManagementAuthorization("https://a.example", snapshot),
      b: useServerManagementAuthorization("https://b.example", snapshot)
    };
  });
  await waitFor(() => expect(hook.result.current.a.management?.authorization).toBeTruthy());
  await waitFor(() => expect(hook.result.current.b.management?.authorization).toBeTruthy());
  return hook;
}

it("keeps A revoke successful when B changes during its status refresh without rolling B back", async () => {
  const { result } = await load();
  const refresh = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus.mockReturnValueOnce(refresh.promise);
  api.revokeManagementDevice.mockResolvedValue({ ...authorized("a"), devices: [] });
  let action!: Promise<boolean>;
  await act(async () => {
    action = result.current.a.revoke(deviceId);
  });
  await act(async () => statusChanged(changed("b", "r2")));
  await act(async () => refresh.resolve(initial));
  expect(await action).toBe(true);
  expect(result.current.a.error).toBeNull();
  expect(result.current.a.management?.devices).toEqual([]);
  expect(result.current.b.profile?.credentialRevision).toBe("r2");
  expect(result.current.b.management?.authorization).toBeTruthy();
});

it("rechecks A's replacement credential instead of accepting its old revoke authorization", async () => {
  const { result } = await load();
  const refresh = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus.mockReturnValueOnce(refresh.promise);
  api.revokeManagementDevice.mockResolvedValue({ ...authorized("a"), devices: [] });
  let action!: Promise<boolean>;
  await act(async () => {
    action = result.current.a.revoke(deviceId);
  });
  api.getManagementAuthorization.mockResolvedValue({
    profileId: "a",
    authorization: null,
    errorCode: "operator_device_revoked"
  });
  await act(async () => statusChanged(changed("a", "r2")));
  await act(async () => refresh.resolve(initial));
  await act(async () => {
    await action;
  });
  expect(result.current.a.profile?.credentialRevision).toBe("r2");
  expect(result.current.a.management?.authorization).toBeNull();
  expect(result.current.a.management?.errorCode).toBe("operator_device_revoked");
  expect(result.current.b.management?.authorization).toBeTruthy();
});

it("reports a real status read failure after revoke only on A", async () => {
  const { result } = await load();
  api.revokeManagementDevice.mockResolvedValue({ ...authorized("a"), devices: [] });
  api.getOperatorControlStatus.mockRejectedValueOnce(new Error("operator_offline"));
  let success!: boolean;
  await act(async () => {
    success = await result.current.a.revoke(deviceId);
  });
  expect(success).toBe(false);
  expect(result.current.a.error).toBe("operator_offline");
  expect(result.current.b.error).toBeNull();
  expect(result.current.b.management?.authorization).toBeTruthy();
});

it("keeps concurrent A and B revoke results when their full status reads finish out of order", async () => {
  const { result } = await load();
  const aRead = deferred<OperatorControlStatus>();
  const bRead = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus
    .mockReturnValueOnce(aRead.promise)
    .mockReturnValueOnce(bRead.promise);
  api.revokeManagementDevice.mockImplementation(({ profileId }: { profileId: string }) =>
    Promise.resolve({ ...authorized(profileId), devices: [] })
  );
  let a!: Promise<boolean>;
  let b!: Promise<boolean>;
  await act(async () => {
    a = result.current.a.revoke(deviceId);
  });
  await act(async () => {
    b = result.current.b.revoke(deviceId);
  });
  await act(async () => bRead.resolve(initial));
  await act(async () => aRead.resolve(initial));
  expect(await a).toBe(true);
  expect(await b).toBe(true);
  expect(result.current.a.management?.devices).toEqual([]);
  expect(result.current.b.management?.devices).toEqual([]);
  expect(result.current.a.error).toBeNull();
  expect(result.current.b.error).toBeNull();
});

it.each([
  "profile",
  "activeProfile"
] as const)("retries the authoritative snapshot after a %s conflict read fails, then checks the resolved identity", async (kind) => {
  const { result } = await load();
  const conflicting =
    kind === "profile"
      ? { ...changed("a", "r2"), updatedAt: initial.updatedAt }
      : { ...initial, activeProfileId: "alternate" };
  api.getOperatorControlStatus.mockRejectedValueOnce(new Error("operator_offline"));
  await act(async () => statusChanged(conflicting));
  expect(result.current.a.error).toBe("operator_offline");
  expect(result.current.b.error).toBeNull();
  const retry = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus.mockReturnValueOnce(retry.promise);
  const checksBefore = api.getManagementAuthorization.mock.calls.length;
  await act(async () => result.current.a.refresh());
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checksBefore);
  await act(async () => retry.resolve(conflicting));
  await waitFor(() => expect(result.current.a.error).toBeNull());
  expect(result.current.a.profileId).toBe(kind === "profile" ? "a" : "alternate");
  expect(result.current.a.profile?.credentialRevision).toBe(kind === "profile" ? "r2" : "r1");
  expect(result.current.a.management?.profileId).toBe(kind === "profile" ? "a" : "alternate");
  expect(result.current.b.error).toBeNull();
  expect(result.current.b.management?.authorization).toBeTruthy();
});

it("retains the conflict and reports a second read failure without checking ambiguous credentials", async () => {
  const { result } = await load();
  api.getOperatorControlStatus.mockRejectedValueOnce(new Error("operator_offline"));
  await act(async () => statusChanged({ ...changed("a", "r2"), updatedAt: initial.updatedAt }));
  expect(result.current.a.error).toBe("operator_offline");
  api.getOperatorControlStatus.mockRejectedValueOnce(new Error("operator_timeout"));
  const checksBefore = api.getManagementAuthorization.mock.calls.length;
  await act(async () => result.current.a.refresh());
  await waitFor(() => expect(result.current.a.error).toBe("operator_timeout"));
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checksBefore);
  expect(result.current.a.checking).toBe(false);
  expect(result.current.b.error).toBeNull();
  expect(result.current.b.management?.authorization).toBeTruthy();
  api.getOperatorControlStatus.mockResolvedValueOnce(initial);
  await act(async () => result.current.a.refresh());
  await waitFor(() => expect(result.current.a.error).toBeNull());
  expect(result.current.a.checking).toBe(false);
  expect(result.current.a.management?.authorization).toBeTruthy();
});

async function failConflictRead() {
  api.getOperatorControlStatus.mockRejectedValueOnce(new Error("operator_offline"));
  await act(async () => statusChanged({ ...changed("a", "r2"), updatedAt: initial.updatedAt }));
}

it.each([
  "success",
  "failure"
] as const)("ignores an old conflict retry %s after selecting another identity", async (outcome) => {
  const { result } = await load();
  await failConflictRead();
  const pending = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus.mockReturnValueOnce(pending.promise);
  await act(async () => result.current.a.refresh());
  await act(async () => result.current.a.selectProfile("alternate"));
  await waitFor(() => expect(result.current.a.management?.profileId).toBe("alternate"));
  const checks = api.getManagementAuthorization.mock.calls.length;
  await act(async () => {
    if (outcome === "success") pending.resolve(initial);
    else pending.reject(new Error("operator_timeout"));
  });
  expect(result.current.a.profileId).toBe("alternate");
  expect(result.current.a.management?.profileId).toBe("alternate");
  expect(result.current.a.error).toBeNull();
  expect(result.current.a.checking).toBe(false);
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checks);
  expect(result.current.b.error).toBeNull();
  expect(result.current.b.management?.authorization).toBeTruthy();
});

it.each([
  "success",
  "failure"
] as const)("does not let an older retry %s replace the newer retry's success for the same authority", async (outcome) => {
  const { result } = await load();
  await failConflictRead();
  const older = deferred<OperatorControlStatus>();
  const newer = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  await act(async () => result.current.a.refresh());
  await act(async () => result.current.a.refresh());
  await act(async () => newer.resolve(initial));
  await waitFor(() => expect(result.current.a.error).toBeNull());
  await waitFor(() => expect(result.current.a.checking).toBe(false));
  const checks = api.getManagementAuthorization.mock.calls.length;
  await act(async () => {
    if (outcome === "success") older.resolve(initial);
    else older.reject(new Error("operator_timeout"));
  });
  expect(result.current.a.error).toBeNull();
  expect(result.current.a.checking).toBe(false);
  expect(result.current.a.management?.authorization).toBeTruthy();
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checks);
  expect(result.current.b.error).toBeNull();
});

it("keeps checking active until the current conflict retry and authorization check both settle", async () => {
  const { result } = await load();
  await failConflictRead();
  const older = deferred<OperatorControlStatus>();
  const newer = deferred<OperatorControlStatus>();
  const authorization = deferred<OperatorManagementView>();
  api.getOperatorControlStatus
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  await act(async () => result.current.a.refresh());
  expect(result.current.a.checking).toBe(true);
  expect(result.current.b.checking).toBe(false);
  await act(async () => result.current.a.refresh());
  await act(async () => older.reject(new Error("operator_timeout")));
  expect(result.current.a.checking).toBe(true);
  expect(result.current.a.error).not.toBe("operator_timeout");
  api.getManagementAuthorization.mockReturnValueOnce(authorization.promise);
  await act(async () => newer.resolve(initial));
  expect(result.current.a.checking).toBe(true);
  await act(async () => authorization.resolve(authorized("a")));
  expect(result.current.a.checking).toBe(false);
  expect(result.current.a.error).toBeNull();
  expect(result.current.b.management?.authorization).toBeTruthy();
});

it.each([
  "success",
  "failure"
] as const)("does not start authorization reads after an unmounted conflict retry %s", async (outcome) => {
  const { result, unmount } = await load();
  await failConflictRead();
  const pending = deferred<OperatorControlStatus>();
  api.getOperatorControlStatus.mockReturnValueOnce(pending.promise);
  await act(async () => result.current.a.refresh());
  const checks = api.getManagementAuthorization.mock.calls.length;
  unmount();
  await act(async () => {
    if (outcome === "success") pending.resolve(initial);
    else pending.reject(new Error("operator_timeout"));
  });
  expect(api.getManagementAuthorization).toHaveBeenCalledTimes(checks);
});
