import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import {
  hashOperatorToken,
  OperatorTokenRegistry,
  type OperatorCredential
} from "../operatorAuth.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { SetupCodeService, mintHostCredentialTokenForTests } from "../identity/setupCodeService.js";
import { SetupCodeStore } from "../identity/setupCodeStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";

const rootToken = `pw_operator_${"A".repeat(43)}`;
const delegatedToken = `pw_operator_${"B".repeat(43)}`;
const deviceToken = `pw_operator_${"C".repeat(43)}`;
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = () => now;
  const workspaces = new WorkspaceIdentityRepository(database);
  const workspaceA = workspaces.ensureConfiguredWorkspace("workspace-authority-a");
  const workspaceB = workspaces.ensureConfiguredWorkspace("workspace-authority-b");
  const credentials: OperatorCredential[] = [
    {
      operatorId: "admin",
      tokenSha256: hashOperatorToken(rootToken),
      projectIds: [],
      serverAdmin: true
    }
  ];
  const registry = new OperatorTokenRegistry(database, credentials, clock, 3_600_000);
  const sessions = new OperatorSessionStore(database, clock);
  const root = sessions.create({
    workspaceId: workspaceA,
    operatorId: "admin",
    credentialSha256: hashOperatorToken(rootToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-02T00:00:00.000Z"
  });
  const administrator = registry.authenticate(`Bearer ${rootToken}`);
  if (!administrator) throw new Error("missing_root_principal");
  const setup = new SetupCodeService({
    database,
    issuerAuthorization: registry.management,
    serverBaseUrl: "http://127.0.0.1:7443/",
    allowInsecureTransport: true,
    clock
  });
  const delegated = () => {
    const principal = registry.authenticate(`Bearer ${delegatedToken}`);
    if (!principal) throw new Error("missing_delegated_principal");
    return principal;
  };
  const issueDelegated = () => {
    registry.management.authorize(administrator, "admin", delegatedToken);
    return delegated();
  };
  return {
    database,
    clock,
    credentials,
    registry,
    sessions,
    root,
    administrator,
    setup,
    workspaceA,
    workspaceB,
    delegated,
    issueDelegated,
    setTime(value: string) {
      now = new Date(value);
    }
  };
}

type Purpose = "device_session" | "operator_session" | "host_enrollment";

function redeem(setup: SetupCodeService, purpose: Purpose, setupCode: string) {
  if (purpose === "host_enrollment")
    return setup.redeem({
      schemaVersion: "workspace-setup/v1",
      purpose,
      setupCode,
      displayName: "Remote Host",
      capabilities: ["linux"],
      capacity: 1,
      enrollmentAttemptId: "enroll-authority-test",
      hostCredentialToken: mintHostCredentialTokenForTests()
    });
  return setup.redeem({
    schemaVersion: "workspace-setup/v1",
    purpose,
    setupCode,
    displayName: "Remote Participant"
  });
}

function sideEffects(database: SqliteDatabase, setupCodeId: string) {
  const count = (table: string) =>
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count;
  return {
    memberships: count("workspace_memberships"),
    devices: count("workspace_device_sessions"),
    operators: count("workspace_operator_sessions"),
    hosts: count("agent_hosts"),
    grant: database
      .prepare(
        "SELECT redeemed_at,redemption_subject_id FROM setup_code_grants WHERE setup_code_id=?"
      )
      .get(setupCodeId)
  };
}

describe("setup code issuer authority", () => {
  it.each([
    { missingColumn: "issued_by_operator_id", purpose: "device_session" },
    { missingColumn: "issued_by_operator_session_id", purpose: "host_enrollment" }
  ] as const)("rejects partial issuer provenance when $missingColumn is NULL", async ({
    missingColumn,
    purpose
  }) => {
    const f = await fixture();
    const issuer = f.issueDelegated();
    const issued = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose
    });
    f.database
      .prepare(`UPDATE setup_code_grants SET ${missingColumn}=NULL WHERE setup_code_id=?`)
      .run(issued.grant.setupCodeId);
    f.sessions.revoke(f.workspaceA, f.root.operatorSessionId);
    const before = sideEffects(f.database, issued.grant.setupCodeId);
    expect(() => redeem(f.setup, purpose, issued.setupCode)).toThrow("setup_code_issuer_revoked");
    expect(sideEffects(f.database, issued.grant.setupCodeId)).toEqual(before);
  });

  it.each([
    "device_session",
    "operator_session",
    "host_enrollment"
  ] as const)("rejects outstanding %s codes after root revocation without side effects", async (purpose) => {
    const f = await fixture();
    const issuer = f.issueDelegated();
    const issued = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose
    });
    f.sessions.revoke(f.workspaceA, f.root.operatorSessionId);
    const before = sideEffects(f.database, issued.grant.setupCodeId);
    expect(() => redeem(f.setup, purpose, issued.setupCode)).toThrow("setup_code_issuer_revoked");
    expect(sideEffects(f.database, issued.grant.setupCodeId)).toEqual(before);
    expect(() =>
      f.setup.issue(issuer, {
        schemaVersion: "workspace-setup/v1",
        workspaceId: f.workspaceB,
        purpose
      })
    ).toThrow();
  });

  it.each([
    "replace_digest",
    "remove_admin"
  ] as const)("rejects outstanding delegated code when config changes: %s", async (change) => {
    const f = await fixture();
    const issuer = f.issueDelegated();
    const issued = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose: "device_session"
    });
    const changed: OperatorCredential[] = [
      {
        ...f.credentials[0],
        ...(change === "replace_digest" ? { tokenSha256: "f".repeat(64) } : { serverAdmin: false })
      }
    ];
    const reloaded = new OperatorTokenRegistry(f.database, changed, f.clock, 3_600_000);
    const setup = new SetupCodeService({
      database: f.database,
      issuerAuthorization: reloaded.management,
      serverBaseUrl: "http://127.0.0.1:7443/",
      allowInsecureTransport: true,
      clock: f.clock
    });
    expect(reloaded.authenticate(`Bearer ${delegatedToken}`)?.serverAdmin).toBe(false);
    const before = sideEffects(f.database, issued.grant.setupCodeId);
    expect(() => redeem(setup, "device_session", issued.setupCode)).toThrow(
      "setup_code_issuer_revoked"
    );
    expect(sideEffects(f.database, issued.grant.setupCodeId)).toEqual(before);
    expect(() =>
      setup.issue(issuer, {
        schemaVersion: "workspace-setup/v1",
        workspaceId: f.workspaceB,
        purpose: "device_session"
      })
    ).toThrow();
  });

  it("rejects a code after its management device is revoked", async () => {
    const f = await fixture();
    const management = f.registry.management;
    const deviceSecret = `pw_device_${"D".repeat(43)}`;
    const device = management.devices.enroll(f.administrator, {
      deviceSecret,
      deviceName: "Laptop"
    });
    management.devices.refresh({ deviceSecret, newToken: deviceToken });
    const issuer = f.registry.authenticate(`Bearer ${deviceToken}`);
    if (!issuer) throw new Error("missing_device_principal");
    const issued = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose: "operator_session"
    });
    const redeemedBeforeRevocation = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose: "device_session"
    });
    expect(redeem(f.setup, "device_session", redeemedBeforeRevocation.setupCode).purpose).toBe(
      "device_session"
    );
    management.devices.revoke(f.administrator, device.deviceId);
    const before = sideEffects(f.database, issued.grant.setupCodeId);
    expect(() => redeem(f.setup, "operator_session", issued.setupCode)).toThrow(
      "setup_code_issuer_revoked"
    );
    expect(sideEffects(f.database, issued.grant.setupCodeId)).toEqual(before);
  });

  it("accepts durable delegation after short access expiry, then rejects code expiry", async () => {
    const f = await fixture();
    const issuer = f.issueDelegated();
    const issued = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose: "device_session",
      ttlMs: 3 * 3_600_000
    });
    const later = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose: "device_session",
      ttlMs: 60_000
    });
    f.setTime("2030-01-01T01:30:00.000Z");
    expect(f.registry.authenticate(`Bearer ${delegatedToken}`)).toBeUndefined();
    expect(redeem(f.setup, "device_session", issued.setupCode).purpose).toBe("device_session");
    const before = sideEffects(f.database, later.grant.setupCodeId);
    expect(() => redeem(f.setup, "device_session", later.setupCode)).toThrow("setup_code_expired");
    expect(sideEffects(f.database, later.grant.setupCodeId)).toEqual(before);
  });

  it("rejects missing and mismatched issuers before creating any identity", async () => {
    const f = await fixture();
    const issuer = f.issueDelegated();
    for (const mutation of ["missing", "mismatch"] as const) {
      const issued = f.setup.issue(issuer, {
        schemaVersion: "workspace-setup/v1",
        workspaceId: f.workspaceB,
        purpose: "device_session"
      });
      f.database
        .prepare(
          `UPDATE setup_code_grants SET ${
            mutation === "missing"
              ? "issued_by_operator_session_id='operator-session-missing'"
              : "issued_by_operator_id='different-operator'"
          } WHERE setup_code_id=?`
        )
        .run(issued.grant.setupCodeId);
      const before = sideEffects(f.database, issued.grant.setupCodeId);
      expect(() => redeem(f.setup, "device_session", issued.setupCode)).toThrow(
        "setup_code_issuer_revoked"
      );
      expect(sideEffects(f.database, issued.grant.setupCodeId)).toEqual(before);
    }
  });

  it("keeps controlled issuerless bootstrap and rolls back failed redemption", async () => {
    const f = await fixture();
    const bootstrap = new SetupCodeStore(f.database, f.clock).insertGrant({
      workspaceId: f.workspaceB,
      purpose: "operator_session"
    });
    expect(redeem(f.setup, "operator_session", bootstrap.setupCode).purpose).toBe(
      "operator_session"
    );
    expect(() => redeem(f.setup, "operator_session", bootstrap.setupCode)).toThrow(
      "setup_code_redeemed"
    );

    const issuer = f.issueDelegated();
    const issued = f.setup.issue(issuer, {
      schemaVersion: "workspace-setup/v1",
      workspaceId: f.workspaceB,
      purpose: "device_session"
    });
    const failing = new SetupCodeService({
      database: f.database,
      issuerAuthorization: f.registry.management,
      serverBaseUrl: "http://127.0.0.1:7443/",
      allowInsecureTransport: true,
      clock: f.clock,
      onWorkspaceDeviceMembershipCreated: () => {
        throw new Error("injected_membership_failure");
      }
    });
    const before = sideEffects(f.database, issued.grant.setupCodeId);
    expect(() => redeem(failing, "device_session", issued.setupCode)).toThrow(
      "injected_membership_failure"
    );
    expect(sideEffects(f.database, issued.grant.setupCodeId)).toEqual(before);
    expect(redeem(f.setup, "device_session", issued.setupCode).purpose).toBe("device_session");
  });
});
