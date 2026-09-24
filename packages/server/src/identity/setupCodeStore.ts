import { randomUUID } from "node:crypto";
import {
  deriveSetupCodeLifecycleState,
  setupCodeGrantSchema,
  setupCodeGrantViewSchema,
  setupCodeRevocationSchema,
  defaultSetupCodeTtlMs,
  type SetupCodeGrant,
  type SetupCodeGrantView,
  type SetupCodeRevocation
} from "@planweave-ai/collaboration-protocol/setup";
import {
  setupCodeIdSchema,
  setupCodeRevocationIdSchema,
  setupCodeTtlMsSchema,
  setupCredentialPurposeSchema,
  type SetupCredentialPurpose
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { SqliteDatabase } from "../sqlite.js";
import { hashSetupCode, mintSetupCodeToken } from "./setupCodeCrypto.js";

type SetupCodeGrantRow = {
  setup_code_id: string;
  workspace_id: string;
  purpose: string;
  code_sha256: string;
  issued_at: string;
  expires_at: string;
  displayed_at: string | null;
  redeemed_at: string | null;
  revoked_at: string | null;
  redemption_subject_id: string | null;
  issued_by_operator_id: string | null;
  issued_by_operator_session_id: string | null;
  credential_expires_at: string | null;
};

type SetupCodeHostEnrollmentOutcomeRow = {
  setup_code_id: string;
  enrollment_attempt_id: string;
  request_sha256: string;
  enrollment_id: string;
  host_id: string;
  credential_expires_at: string;
  created_at: string;
};

export type SetupCodeHostEnrollmentOutcome = {
  setupCodeId: string;
  enrollmentAttemptId: string;
  requestSha256: string;
  enrollmentId: string;
  hostId: string;
  credentialExpiresAt: string;
  createdAt: string;
};

function toHostEnrollmentOutcome(
  row: SetupCodeHostEnrollmentOutcomeRow
): SetupCodeHostEnrollmentOutcome {
  return {
    setupCodeId: row.setup_code_id,
    enrollmentAttemptId: row.enrollment_attempt_id,
    requestSha256: row.request_sha256,
    enrollmentId: row.enrollment_id,
    hostId: row.host_id,
    credentialExpiresAt: row.credential_expires_at,
    createdAt: row.created_at
  };
}

function toGrant(row: SetupCodeGrantRow): SetupCodeGrant {
  return setupCodeGrantSchema.parse({
    schemaVersion: "workspace-setup/v1",
    setupCodeId: row.setup_code_id,
    workspaceId: row.workspace_id,
    purpose: row.purpose,
    codeSha256: row.code_sha256,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    displayedAt: row.displayed_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
    redemptionSubjectId: row.redemption_subject_id
  });
}

export function toSetupCodeGrantView(grant: SetupCodeGrant, now: Date): SetupCodeGrantView {
  return setupCodeGrantViewSchema.parse({
    schemaVersion: "workspace-setup/v1",
    setupCodeId: grant.setupCodeId,
    workspaceId: grant.workspaceId,
    purpose: grant.purpose,
    state: deriveSetupCodeLifecycleState({ grant, now }),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    displayedAt: grant.displayedAt,
    redeemedAt: grant.redeemedAt,
    revokedAt: grant.revokedAt
  });
}

export type SetupCodeIssuer = {
  operatorId: string;
  operatorSessionId: string;
};

type SetupCodeIssuerSource =
  | { kind: "bootstrap" }
  | { kind: "incomplete" }
  | { kind: "issued"; issuer: SetupCodeIssuer };

export class SetupCodeStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  insertGrant(input: {
    workspaceId: string;
    purpose: SetupCredentialPurpose;
    ttlMs?: number;
    issuer?: SetupCodeIssuer;
    credentialExpiresAt?: string | null;
  }): { grant: SetupCodeGrant; setupCode: string } {
    const purpose = setupCredentialPurposeSchema.parse(input.purpose);
    const ttlMs =
      input.ttlMs === undefined ? defaultSetupCodeTtlMs() : setupCodeTtlMsSchema.parse(input.ttlMs);
    const now = this.clock();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const setupCode = mintSetupCodeToken();
    const codeSha256 = hashSetupCode(setupCode);
    const setupCodeId = setupCodeIdSchema.parse(`setup-code-${randomUUID()}`);
    const displayedAt = issuedAt;
    this.database
      .prepare(
        `INSERT INTO setup_code_grants(
          setup_code_id,workspace_id,purpose,code_sha256,issued_at,expires_at,displayed_at,
          redeemed_at,revoked_at,redemption_subject_id,issued_by_operator_id,
          issued_by_operator_session_id,credential_expires_at
        ) VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?)`
      )
      .run(
        setupCodeId,
        input.workspaceId,
        purpose,
        codeSha256,
        issuedAt,
        expiresAt,
        displayedAt,
        input.issuer?.operatorId ?? null,
        input.issuer?.operatorSessionId ?? null,
        input.credentialExpiresAt ?? null
      );
    return {
      grant: toGrant(
        this.database
          .prepare("SELECT * FROM setup_code_grants WHERE setup_code_id=?")
          .get(setupCodeId) as SetupCodeGrantRow
      ),
      setupCode
    };
  }

  findByToken(
    setupCode: string
  ):
    | (SetupCodeGrant & { issuerSource: SetupCodeIssuerSource; credentialExpiresAt: string | null })
    | undefined {
    let digest: string;
    try {
      digest = hashSetupCode(setupCode);
    } catch {
      return undefined;
    }
    const row = this.database
      .prepare("SELECT * FROM setup_code_grants WHERE code_sha256=?")
      .get(digest) as SetupCodeGrantRow | undefined;
    if (!row) return undefined;
    return this.enrich(row);
  }

  getById(
    setupCodeId: string
  ):
    | (SetupCodeGrant & { issuerSource: SetupCodeIssuerSource; credentialExpiresAt: string | null })
    | undefined {
    const id = setupCodeIdSchema.parse(setupCodeId);
    const row = this.database
      .prepare("SELECT * FROM setup_code_grants WHERE setup_code_id=?")
      .get(id) as SetupCodeGrantRow | undefined;
    if (!row) return undefined;
    return this.enrich(row);
  }

  listForWorkspace(
    workspaceId: string,
    options: { cursor: number; limit: number; openOnly?: boolean }
  ): SetupCodeGrant[] {
    const rows = options.openOnly
      ? (this.database
          .prepare(
            `SELECT * FROM setup_code_grants
               WHERE workspace_id=? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?
               ORDER BY issued_at ASC, setup_code_id ASC
               LIMIT ? OFFSET ?`
          )
          .all(
            workspaceId,
            this.clock().toISOString(),
            options.limit,
            options.cursor
          ) as SetupCodeGrantRow[])
      : (this.database
          .prepare(
            `SELECT * FROM setup_code_grants
               WHERE workspace_id=?
               ORDER BY issued_at ASC, setup_code_id ASC
               LIMIT ? OFFSET ?`
          )
          .all(workspaceId, options.limit, options.cursor) as SetupCodeGrantRow[]);
    return rows.map(toGrant);
  }

  markRedeemed(setupCodeId: string, redemptionSubjectId: string): SetupCodeGrant {
    const now = this.clock().toISOString();
    const updated = this.database
      .prepare(
        `UPDATE setup_code_grants
         SET redeemed_at=?, redemption_subject_id=?
         WHERE setup_code_id=? AND redeemed_at IS NULL AND revoked_at IS NULL`
      )
      .run(now, redemptionSubjectId, setupCodeId);
    if (updated.changes !== 1) throw new Error("setup_code_redeem_conflict");
    const grant = this.getById(setupCodeId);
    if (!grant) throw new Error("setup_code_not_found");
    return grant;
  }

  findHostEnrollmentOutcome(setupCodeId: string): SetupCodeHostEnrollmentOutcome | undefined {
    const row = this.database
      .prepare("SELECT * FROM setup_code_host_enrollment_outcomes WHERE setup_code_id=?")
      .get(setupCodeId) as SetupCodeHostEnrollmentOutcomeRow | undefined;
    return row ? toHostEnrollmentOutcome(row) : undefined;
  }

  insertHostEnrollmentOutcome(input: SetupCodeHostEnrollmentOutcome): void {
    this.database
      .prepare(
        `INSERT INTO setup_code_host_enrollment_outcomes(
          setup_code_id,enrollment_attempt_id,request_sha256,enrollment_id,host_id,
          credential_expires_at,created_at
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        input.setupCodeId,
        input.enrollmentAttemptId,
        input.requestSha256,
        input.enrollmentId,
        input.hostId,
        input.credentialExpiresAt,
        input.createdAt
      );
  }

  revoke(setupCodeId: string, reason: string): SetupCodeRevocation {
    const grant = this.getById(setupCodeId);
    if (!grant) throw new Error("setup_code_not_found");
    if (grant.revokedAt) throw new Error("setup_code_already_revoked");
    if (grant.redeemedAt) throw new Error("setup_code_already_redeemed");
    const now = this.clock().toISOString();
    const updated = this.database
      .prepare(
        `UPDATE setup_code_grants SET revoked_at=?
         WHERE setup_code_id=? AND revoked_at IS NULL AND redeemed_at IS NULL`
      )
      .run(now, setupCodeId);
    if (updated.changes !== 1) throw new Error("setup_code_revoke_conflict");
    const revocationId = setupCodeRevocationIdSchema.parse(`setup-revocation-${randomUUID()}`);
    this.database
      .prepare(
        `INSERT INTO setup_code_revocations(
          revocation_id,setup_code_id,workspace_id,purpose,revoked_at,reason
        ) VALUES(?,?,?,?,?,?)`
      )
      .run(revocationId, grant.setupCodeId, grant.workspaceId, grant.purpose, now, reason);
    return setupCodeRevocationSchema.parse({
      schemaVersion: "workspace-setup/v1",
      revocationId,
      setupCodeId: grant.setupCodeId,
      workspaceId: grant.workspaceId,
      purpose: grant.purpose,
      revokedAt: now,
      reason
    });
  }

  private enrich(row: SetupCodeGrantRow): SetupCodeGrant & {
    issuerSource: SetupCodeIssuerSource;
    credentialExpiresAt: string | null;
  } {
    const grant = toGrant(row);
    let issuerSource: SetupCodeIssuerSource;
    if (row.issued_by_operator_id === null && row.issued_by_operator_session_id === null) {
      issuerSource = { kind: "bootstrap" };
    } else if (row.issued_by_operator_id === null || row.issued_by_operator_session_id === null) {
      issuerSource = { kind: "incomplete" };
    } else {
      issuerSource = {
        kind: "issued",
        issuer: {
          operatorId: row.issued_by_operator_id,
          operatorSessionId: row.issued_by_operator_session_id
        }
      };
    }
    return {
      ...grant,
      credentialExpiresAt: row.credential_expires_at,
      issuerSource
    };
  }
}
