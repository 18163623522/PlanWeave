import { expect, it, vi } from "vitest";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";

const rootToken = `pw_operator_${"A".repeat(43)}`;
const deviceSecret = `pw_device_${"D".repeat(43)}`;

function observedCount(registry: OperatorTokenRegistry, operatorId: string): number {
  const principals: unknown = Reflect.get(registry, "principals");
  if (!(principals instanceof Map)) throw new Error("operator_cache_missing");
  const sessions: unknown = principals.get(operatorId);
  if (sessions === undefined) return 0;
  if (!(sessions instanceof Map)) throw new Error("operator_bucket_invalid");
  return sessions.size;
}

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = () => now;
  const workspaceId = new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(
    "cache-workspace"
  );
  const sessions = new OperatorSessionStore(database, clock);
  const root = sessions.create({
    workspaceId,
    operatorId: "admin",
    credentialSha256: hashOperatorToken(rootToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T01:00:00.000Z"
  });
  const credentials = [
    {
      operatorId: "admin",
      tokenSha256: hashOperatorToken(rootToken),
      projectIds: [],
      serverAdmin: true
    }
  ];
  const registry = new OperatorTokenRegistry(database, credentials, clock);
  return {
    database,
    sessions,
    registry,
    root,
    credentials,
    workspaceId,
    clock,
    advanceHours: (hours: number) => {
      now = new Date(now.getTime() + hours * 3_600_000);
    }
  };
}

it.each([
  10, 100, 1000
])("keeps observed refresh authority bounded after %i expired device sessions", async (rounds) => {
  const f = await fixture();
  try {
    const root = f.registry.authenticate(`Bearer ${rootToken}`)!;
    f.registry.management.devices.enroll(root, { deviceSecret, deviceName: "Laptop" });
    for (let index = 0; index < rounds; index++) {
      const token = `pw_operator_${String(index).padStart(43, "B")}`;
      f.registry.management.devices.refresh({ deviceSecret, newToken: token });
      expect(f.registry.authenticate(`Bearer ${token}`)).toBeDefined();
      f.advanceHours(2);
    }
    const liveToken = `pw_operator_${"Z".repeat(43)}`;
    f.registry.management.devices.refresh({ deviceSecret, newToken: liveToken });
    expect(f.registry.authenticate(`Bearer ${liveToken}`)).toBeDefined();
    const prepare = vi.spyOn(f.database, "prepare");
    const allowed = f.registry.canRespond({
      responderId: "admin",
      workspaceId: f.workspaceId,
      projectId: "project-a"
    });
    const queries = prepare.mock.calls.length;
    prepare.mockRestore();
    const cached = observedCount(f.registry, "admin");
    expect({ rounds, alive: 1, cached, queries, allowed }).toEqual({
      rounds,
      alive: 1,
      cached: 1,
      queries: 8,
      allowed: true
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
    ).toBe(rounds + 2);
    expect(allowed).toBe(true);
  } finally {
    f.database.close();
  }
});

it("uses the database expiry after maintain extends an observed session", async () => {
  const f = await fixture();
  try {
    const principal = f.registry.authenticate(`Bearer ${rootToken}`)!;
    f.advanceHours(0.9);
    expect(f.registry.management.maintain(principal).expiresAt).toBe("2030-01-31T00:54:00.000Z");
    f.advanceHours(0.2);
    expect(
      f.registry.canRespond({ responderId: "admin", workspaceId: f.workspaceId, projectId: "any" })
    ).toBe(true);
    expect(observedCount(f.registry, "admin")).toBe(1);
  } finally {
    f.database.close();
  }
});

it("does not authorize persisted sessions until this registry observes them and removes empty buckets", async () => {
  const f = await fixture();
  try {
    const target = { responderId: "admin", workspaceId: f.workspaceId, projectId: "any" };
    expect(f.registry.canRespond(target)).toBe(false);
    expect(f.registry.canRespond({ ...target, responderId: "unknown" })).toBe(false);
    const restarted = new OperatorTokenRegistry(f.database, f.credentials, f.clock);
    expect(restarted.canRespond(target)).toBe(false);
    expect(restarted.authenticate(`Bearer ${rootToken}`)).toBeDefined();
    expect(restarted.canRespond(target)).toBe(true);
    f.advanceHours(2);
    expect(restarted.canRespond(target)).toBe(false);
    expect(observedCount(restarted, "admin")).toBe(0);
    expect(restarted.canRespond(target)).toBe(false);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
    ).toBe(1);
  } finally {
    f.database.close();
  }
});

it("keeps exact project and workspace scope and drops a session after identity cutover is withdrawn", async () => {
  const database = await openServerDatabase(":memory:", 5_000);
  try {
    applyMigrations(database);
    const identity = new WorkspaceIdentityRepository(database);
    const firstWorkspace = identity.ensureWorkspaceForLegacyProject("project-a");
    const secondWorkspace = identity.ensureWorkspaceForLegacyProject("project-b");
    const token = `pw_operator_${"M".repeat(43)}`;
    const store = new OperatorSessionStore(database, () => new Date("2030-01-01T00:00:00.000Z"));
    store.create({
      workspaceId: firstWorkspace,
      operatorId: "member",
      credentialSha256: hashOperatorToken(token),
      issuedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T01:00:00.000Z"
    });
    const registry = new OperatorTokenRegistry(
      database,
      [{ operatorId: "member", tokenSha256: hashOperatorToken(token), projectIds: ["project-a"] }],
      () => new Date("2030-01-01T00:00:00.000Z")
    );
    expect(registry.authenticate(`Bearer ${token}`)).toBeDefined();
    expect(
      registry.canRespond({
        responderId: "member",
        workspaceId: firstWorkspace,
        projectId: "project-a"
      })
    ).toBe(true);
    expect(
      registry.canRespond({
        responderId: "member",
        workspaceId: firstWorkspace,
        projectId: "project-b"
      })
    ).toBe(false);
    expect(
      registry.canRespond({
        responderId: "member",
        workspaceId: secondWorkspace,
        projectId: "project-a"
      })
    ).toBe(false);
    database
      .prepare(
        "UPDATE workspace_identity_migrations SET status='in_progress', interruption_marker='workspace_created' WHERE workspace_id=?"
      )
      .run(firstWorkspace);
    expect(
      registry.canRespond({
        responderId: "member",
        workspaceId: firstWorkspace,
        projectId: "project-a"
      })
    ).toBe(false);
    expect(observedCount(registry, "member")).toBe(0);
  } finally {
    database.close();
  }
});

it("retains observed authority across workspaces and rejects session, device, root and config revocation", async () => {
  const f = await fixture();
  try {
    const otherWorkspaceId = new WorkspaceIdentityRepository(f.database).ensureConfiguredWorkspace(
      "cache-other-workspace"
    );
    const root = f.registry.authenticate(`Bearer ${rootToken}`)!;
    const device = f.registry.management.devices.enroll(root, {
      deviceSecret,
      deviceName: "Laptop"
    });
    const firstToken = `pw_operator_${"E".repeat(43)}`;
    f.registry.management.devices.refresh({ deviceSecret, newToken: firstToken });
    const first = f.registry.authenticate(`Bearer ${firstToken}`)!;
    const otherToken = `pw_operator_${"F".repeat(43)}`;
    const other = f.sessions.create({
      workspaceId: otherWorkspaceId,
      operatorId: "admin",
      credentialSha256: hashOperatorToken(otherToken),
      issuedAt: f.clock().toISOString(),
      expiresAt: "2030-01-01T01:00:00.000Z"
    });
    f.database
      .prepare(
        "INSERT INTO operator_management_sessions(credential_sha256,authority_sha256,authority_revoked_at) VALUES(?,?,NULL)"
      )
      .run(other.credentialSha256, f.root.credentialSha256);
    expect(f.registry.authenticate(`Bearer ${otherToken}`)).toBeDefined();
    const firstTarget = {
      responderId: "admin",
      workspaceId: f.workspaceId,
      projectId: "project-a"
    };
    const otherTarget = { ...firstTarget, workspaceId: otherWorkspaceId, projectId: "project-b" };
    expect(f.registry.canRespond(firstTarget)).toBe(true);
    expect(f.registry.canRespond(otherTarget)).toBe(true);
    f.sessions.revoke(f.workspaceId, first.operatorSessionId);
    expect(f.registry.canRespond(otherTarget)).toBe(true);
    expect(observedCount(f.registry, "admin")).toBe(2);
    f.registry.management.devices.revoke(root, device.deviceId);
    expect(f.registry.canRespond(otherTarget)).toBe(true);
    const replaced = new OperatorTokenRegistry(
      f.database,
      [{ ...f.credentials[0], tokenSha256: "f".repeat(64) }],
      f.clock
    );
    expect(replaced.authenticate(`Bearer ${otherToken}`)?.serverAdmin).toBe(false);
    expect(replaced.canRespond(otherTarget)).toBe(false);
    f.sessions.revoke(f.workspaceId, f.root.operatorSessionId);
    expect(f.registry.canRespond(otherTarget)).toBe(false);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
    ).toBe(3);
  } finally {
    f.database.close();
  }
});

it.each([
  "session",
  "device",
  "root",
  "config"
] as const)("rejects %s revocation when only a device session can respond", async (change) => {
  const f = await fixture();
  try {
    const root = f.registry.authenticate(`Bearer ${rootToken}`)!;
    const device = f.registry.management.devices.enroll(root, {
      deviceSecret,
      deviceName: "Laptop"
    });
    f.advanceHours(2);
    const accessToken = `pw_operator_${"H".repeat(43)}`;
    f.registry.management.devices.refresh({ deviceSecret, newToken: accessToken });
    const access = f.registry.authenticate(`Bearer ${accessToken}`)!;
    const target = { responderId: "admin", workspaceId: f.workspaceId, projectId: "any" };
    expect(f.registry.canRespond(target)).toBe(true);
    if (change === "session") f.sessions.revoke(f.workspaceId, access.operatorSessionId);
    if (change === "device") f.registry.management.devices.revoke(access, device.deviceId);
    if (change === "root") f.sessions.revoke(f.workspaceId, f.root.operatorSessionId);
    if (change === "config") {
      const replaced = new OperatorTokenRegistry(
        f.database,
        [{ ...f.credentials[0], tokenSha256: "f".repeat(64) }],
        f.clock
      );
      expect(replaced.authenticate(`Bearer ${accessToken}`)?.serverAdmin).toBe(false);
      expect(replaced.canRespond(target)).toBe(false);
    } else {
      expect(f.registry.canRespond(target)).toBe(false);
    }
  } finally {
    f.database.close();
  }
});

it("batches live observed composite keys below SQLite's minimum parameter limit", async () => {
  const f = await fixture();
  try {
    const observed = [];
    for (let index = 0; index < 401; index++) {
      const token = `pw_operator_${String(index).padStart(43, "G")}`;
      observed.push(
        f.sessions.create({
          workspaceId: f.workspaceId,
          operatorId: "admin",
          credentialSha256: hashOperatorToken(token),
          issuedAt: f.clock().toISOString(),
          expiresAt: "2030-01-01T01:00:00.000Z"
        })
      );
    }
    const prepare = vi.spyOn(f.database, "prepare");
    const usable = f.sessions.findUsableObserved("admin", observed);
    const batchQueries = prepare.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("operator_session_id) IN (")
    ).length;
    prepare.mockRestore();
    expect(usable).toHaveLength(401);
    expect(batchQueries).toBe(2);
  } finally {
    f.database.close();
  }
});
