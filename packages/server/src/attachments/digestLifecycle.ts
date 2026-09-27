import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { commentContentSha256Schema } from "../comments/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { withAttachmentCleanup } from "./errors.js";

const require = createRequire(import.meta.url);
declare global {
  var planweaveCommentAttachmentProcess:
    | {
        instance: string;
        activeClaims: Set<string>;
      }
    | undefined;
}
if (!globalThis.planweaveCommentAttachmentProcess) {
  globalThis.planweaveCommentAttachmentProcess = {
    instance: randomUUID(),
    activeClaims: new Set<string>()
  };
}
const processState = globalThis.planweaveCommentAttachmentProcess;
const processInstance = processState.instance;
const claimSchema = z.object({
  owner_token: z.string().uuid(),
  process_id: z.number().int().positive(),
  hostname: z.string().min(1),
  process_instance: z.string().uuid()
});

/** Persistent, root-scoped claims; SQLite transactions never span protected file I/O. */
export class CommentAttachmentDigestLifecycle {
  private readonly path: string;
  private readonly databasePath: string;

  constructor(database: SqliteDatabase, dataDirectory: string) {
    const main = database
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main");
    this.databasePath = realpathSync(z.string().min(1).parse(main?.file));
    const root = join(dataDirectory, "comment-attachments");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(realpathSync(root), "lifecycle.sqlite");
    const claims = this.open();
    try {
      chmodSync(this.path, 0o600);
      claims.exec(`CREATE TABLE IF NOT EXISTS attachment_database_root (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_digest_claims (
        digest TEXT PRIMARY KEY, owner_token TEXT NOT NULL, process_id INTEGER NOT NULL,
        hostname TEXT NOT NULL, process_instance TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_process_instances (
        hostname TEXT NOT NULL, process_id INTEGER NOT NULL, process_instance TEXT NOT NULL,
        PRIMARY KEY(hostname,process_id)
      );`);
      inWriteTransaction(claims, () => {
        claims
          .prepare("INSERT OR IGNORE INTO attachment_database_root VALUES(1,?)")
          .run(this.databasePath);
        const bound = claims
          .prepare("SELECT database_path FROM attachment_database_root WHERE singleton=1")
          .get();
        if (bound?.database_path !== this.databasePath)
          throw new Error("attachment_database_root_conflict");
        claims
          .prepare(`INSERT INTO attachment_process_instances VALUES(?,?,?)
          ON CONFLICT(hostname,process_id) DO UPDATE SET process_instance=excluded.process_instance`)
          .run(hostname(), process.pid, processInstance);
      });
    } finally {
      claims.close();
    }
  }

  async withDigest<T>(digestSha256: string, action: () => Promise<T>): Promise<T> {
    const digest = commentContentSha256Schema.parse(digestSha256);
    const token = randomUUID();
    const claims = this.open();
    const deadline = performance.now() + 30_000;
    let acquired = false;
    return withAttachmentCleanup(
      async () => {
        while (!acquired) {
          acquired = inWriteTransaction(claims, () => {
            const raw = claims
              .prepare("SELECT * FROM attachment_digest_claims WHERE digest=?")
              .get(digest);
            if (raw) {
              const owner = claimSchema.parse(raw);
              if (owner.hostname !== hostname())
                throw new Error("attachment_digest_owned_by_remote_host");
              const registered = claims
                .prepare(`SELECT process_instance FROM attachment_process_instances
              WHERE hostname=? AND process_id=?`)
                .get(owner.hostname, owner.process_id);
              if (!registered) throw new Error("attachment_digest_owner_identity_missing");
              const registeredInstance = z.string().uuid().parse(registered.process_instance);
              let active = registeredInstance === owner.process_instance;
              if (owner.process_id === process.pid && owner.process_instance === processInstance) {
                active = processState.activeClaims.has(owner.owner_token);
              }
              if (active) {
                try {
                  process.kill(owner.process_id, 0);
                } catch (error) {
                  if (error instanceof Error && "code" in error && error.code === "ESRCH")
                    active = false;
                  else if (!(error instanceof Error && "code" in error && error.code === "EPERM"))
                    throw error;
                }
              }
              if (active) return false;
              claims
                .prepare("DELETE FROM attachment_digest_claims WHERE digest=? AND owner_token=?")
                .run(digest, owner.owner_token);
            }
            claims
              .prepare("INSERT INTO attachment_digest_claims VALUES(?,?,?,?,?)")
              .run(digest, token, process.pid, hostname(), processInstance);
            return true;
          });
          if (!acquired) {
            if (performance.now() >= deadline) throw new Error("attachment_digest_wait_timeout");
            await delay(10);
          }
        }
        processState.activeClaims.add(token);
        return await action();
      },
      async () => {
        await withAttachmentCleanup(
          async () => {
            if (acquired) {
              const result = claims
                .prepare("DELETE FROM attachment_digest_claims WHERE digest=? AND owner_token=?")
                .run(digest, token);
              if (result.changes !== 1) throw new Error("attachment_digest_ownership_lost");
            }
          },
          async () => {
            processState.activeClaims.delete(token);
            claims.close();
          }
        );
      }
    );
  }

  private open(): SqliteDatabase {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    const database = new DatabaseSync(this.path);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
