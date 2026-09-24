import { createHash, randomUUID } from "node:crypto";
import {
  credentialSha256Schema,
  operatorIdSchema,
  operatorSessionIdSchema,
  operatorCredentialTokenSchema,
  timestampSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  evaluateOperatorSessionUsability,
  operatorSessionSchema,
  type OperatorSession
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import type { SqliteDatabase } from "../sqlite.js";

export type OperatorSessionInput = {
  workspaceId: string;
  operatorSessionId?: string;
  operatorId: string;
  credentialSha256: string;
  issuedAt: string;
  expiresAt: string;
};

function hashOperatorCredential(token: string): string {
  const parsed = operatorCredentialTokenSchema.parse(token);
  return createHash("sha256").update(parsed).digest("hex");
}

/** Durable Server authority for operator session credentials. */
export class OperatorSessionStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  create(input: OperatorSessionInput): OperatorSession {
    const workspaceId = workspaceIdSchema.parse(input.workspaceId);
    const operatorSessionId = operatorSessionIdSchema.parse(
      input.operatorSessionId ?? `operator-session-${randomUUID()}`
    );
    const operatorId = operatorIdSchema.parse(input.operatorId);
    const credentialSha256 = credentialSha256Schema.parse(input.credentialSha256);
    const session = operatorSessionSchema.parse({
      schemaVersion: "workspace-identity/v1",
      workspaceId,
      operatorSessionId,
      operatorId,
      credentialSha256,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      revokedAt: null
    });
    this.assertWorkspaceCutover(workspaceId);
    this.database
      .prepare(
        `INSERT INTO workspace_operator_sessions(
          workspace_id,operator_session_id,operator_id,credential_sha256,issued_at,expires_at,revoked_at
        ) VALUES(?,?,?,?,?,?,NULL)`
      )
      .run(
        session.workspaceId,
        session.operatorSessionId,
        session.operatorId,
        session.credentialSha256,
        session.issuedAt,
        session.expiresAt
      );
    return session;
  }

  authenticate(token: string): OperatorSession | undefined {
    const credentialSha256 = hashOperatorCredential(token);
    return this.authenticateDigest(credentialSha256);
  }

  authenticateDigest(credentialSha256: string): OperatorSession | undefined {
    const session = this.findByCredentialDigest(credentialSha256);
    if (!session) return undefined;
    const usability = evaluateOperatorSessionUsability({
      session,
      workspaceId: session.workspaceId,
      now: this.clock()
    });
    if (!usability.usable) return undefined;
    try {
      this.assertWorkspaceCutover(session.workspaceId);
    } catch {
      return undefined;
    }
    return session;
  }

  findByCredentialDigest(credentialSha256: string): OperatorSession | undefined {
    const digest = credentialSha256Schema.parse(credentialSha256);
    const row = this.database
      .prepare(
        `SELECT workspace_id,operator_session_id,operator_id,credential_sha256,
                issued_at,expires_at,revoked_at
         FROM workspace_operator_sessions WHERE credential_sha256=?`
      )
      .get(digest);
    return row ? this.parseRow(row) : undefined;
  }

  findBySessionId(workspaceId: string, operatorSessionId: string): OperatorSession | undefined {
    const parsedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    const parsedSessionId = operatorSessionIdSchema.parse(operatorSessionId);
    const row = this.database
      .prepare(
        `SELECT workspace_id,operator_session_id,operator_id,credential_sha256,
                issued_at,expires_at,revoked_at
         FROM workspace_operator_sessions
         WHERE workspace_id=? AND operator_session_id=?`
      )
      .get(parsedWorkspaceId, parsedSessionId);
    return row ? this.parseRow(row) : undefined;
  }

  findUsableObserved(
    operatorId: string,
    observed: readonly { workspaceId: string; operatorSessionId: string }[]
  ): OperatorSession[] {
    if (observed.length === 0) return [];
    const parsedOperatorId = operatorIdSchema.parse(operatorId);
    const now = this.clock();
    const sessions: OperatorSession[] = [];
    // Each pair uses two parameters; stay below SQLite's 999-variable minimum limit.
    for (let offset = 0; offset < observed.length; offset += 400) {
      const batch = observed.slice(offset, offset + 400);
      const pairs = batch.map(() => "(?,?)").join(",");
      const values = batch.flatMap(({ workspaceId, operatorSessionId }) => [
        workspaceIdSchema.parse(workspaceId),
        operatorSessionIdSchema.parse(operatorSessionId)
      ]);
      const rows = this.database
        .prepare(
          `SELECT workspace_id,operator_session_id,operator_id,credential_sha256,
                  issued_at,expires_at,revoked_at
           FROM workspace_operator_sessions
           WHERE (workspace_id,operator_session_id) IN (${pairs})
             AND operator_id=? AND revoked_at IS NULL
             AND julianday(expires_at)>julianday(?)`
        )
        .all(...values, parsedOperatorId, now.toISOString());
      for (const row of rows) {
        const session = this.parseRow(row);
        if (
          !evaluateOperatorSessionUsability({ session, workspaceId: session.workspaceId, now })
            .usable
        )
          continue;
        try {
          this.assertWorkspaceCutover(session.workspaceId);
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message === "workspace_not_found" ||
              error.message === "workspace_identity_read_cutover_incomplete")
          )
            continue;
          throw error;
        }
        sessions.push(session);
      }
    }
    return sessions;
  }

  /** Legacy issuer lookup; resolves only one durable operator session ID. */
  findBySessionIdAcrossWorkspaces(operatorSessionId: string): OperatorSession | undefined {
    const parsedSessionId = operatorSessionIdSchema.parse(operatorSessionId);
    const rows = this.database
      .prepare(
        `SELECT workspace_id,operator_session_id,operator_id,credential_sha256,
                issued_at,expires_at,revoked_at
         FROM workspace_operator_sessions WHERE operator_session_id=?`
      )
      .all(parsedSessionId) as Record<string, unknown>[];
    return rows.length === 1 ? this.parseRow(rows[0]) : undefined;
  }

  private parseRow(row: Record<string, unknown>): OperatorSession {
    return operatorSessionSchema.parse({
      schemaVersion: "workspace-identity/v1",
      workspaceId: row.workspace_id,
      operatorSessionId: row.operator_session_id,
      operatorId: row.operator_id,
      credentialSha256: row.credential_sha256,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at
    });
  }

  isActive(workspaceId: string, operatorSessionId: string): boolean {
    const session = this.database
      .prepare(
        `SELECT workspace_id,operator_session_id,operator_id,credential_sha256,
                issued_at,expires_at,revoked_at
         FROM workspace_operator_sessions
         WHERE workspace_id=? AND operator_session_id=?`
      )
      .get(workspaceId, operatorSessionId);
    if (!session) return false;
    return (
      this.authenticateDigest(String(session.credential_sha256))?.operatorSessionId ===
      operatorSessionId
    );
  }

  revoke(
    workspaceId: string,
    operatorSessionId: string,
    revokedAt = this.clock().toISOString()
  ): void {
    const parsedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    const parsedSessionId = operatorSessionIdSchema.parse(operatorSessionId);
    const parsedRevokedAt = timestampSchema.parse(revokedAt);
    const updated = this.database
      .prepare(
        `UPDATE workspace_operator_sessions SET revoked_at=?
         WHERE workspace_id=? AND operator_session_id=? AND revoked_at IS NULL`
      )
      .run(parsedRevokedAt, parsedWorkspaceId, parsedSessionId);
    if (updated.changes !== 1) throw new Error("operator_session_not_found_or_revoked");
  }

  private assertWorkspaceCutover(workspaceId: string): void {
    const workspace = this.database
      .prepare("SELECT 1 FROM workspaces WHERE workspace_id=?")
      .get(workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    const migrationState = this.database
      .prepare(
        `SELECT status,interruption_marker FROM workspace_identity_migrations
         WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(workspaceId);
    const state =
      migrationState ??
      this.database
        .prepare(
          `SELECT status,interruption_marker FROM workspace_identity_registrations
           WHERE workspace_id=?`
        )
        .get(workspaceId);
    if (
      !state ||
      state.status !== "completed" ||
      state.interruption_marker !== "read_cutover_complete"
    ) {
      throw new Error("workspace_identity_read_cutover_incomplete");
    }
  }
}

export function hashOperatorSessionToken(token: string): string {
  return hashOperatorCredential(token);
}
