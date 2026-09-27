import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { commentContentSha256Schema } from "../comments/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { withAttachmentCleanup, withAttachmentCleanupFailure } from "./errors.js";

const require = createRequire(import.meta.url);
const processInstance = randomUUID();
const claimSchema = z.object({
  owner_token: z.string().uuid(),
  process_id: z.number().int().positive(),
  hostname: z.string().min(1),
  process_instance: z.string().uuid(),
  coordination_version: z.union([z.literal(0), z.literal(1)])
});

/** Persistent, root-scoped claims; SQLite transactions never span protected file I/O. */
export class CommentAttachmentDigestLifecycle {
  private readonly path: string;
  private readonly databasePath: string;
  private readonly lockDirectory: string;

  constructor(database: SqliteDatabase, dataDirectory: string) {
    const main = database
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main");
    this.databasePath = realpathSync(z.string().min(1).parse(main?.file));
    const root = join(dataDirectory, "comment-attachments");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(realpathSync(root), "lifecycle.sqlite");
    this.lockDirectory = join(realpathSync(root), "lifecycle-locks");
    mkdirSync(this.lockDirectory, { recursive: true, mode: 0o700 });
    const claims = this.open();
    try {
      chmodSync(this.path, 0o600);
      claims.exec(`CREATE TABLE IF NOT EXISTS attachment_database_root (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_digest_claims (
        digest TEXT PRIMARY KEY, owner_token TEXT NOT NULL, process_id INTEGER NOT NULL,
        hostname TEXT NOT NULL, process_instance TEXT NOT NULL,
        coordination_version INTEGER NOT NULL DEFAULT 0 CHECK(coordination_version IN (0,1))
      );`);
      inWriteTransaction(claims, () => {
        if (
          !claims
            .prepare("PRAGMA table_info(attachment_digest_claims)")
            .all()
            .some((column) => column.name === "coordination_version")
        ) {
          claims.exec(`ALTER TABLE attachment_digest_claims ADD COLUMN
            coordination_version INTEGER NOT NULL DEFAULT 0 CHECK(coordination_version IN (0,1))`);
        }
        claims
          .prepare("INSERT OR IGNORE INTO attachment_database_root VALUES(1,?)")
          .run(this.databasePath);
        const bound = claims
          .prepare("SELECT database_path FROM attachment_database_root WHERE singleton=1")
          .get();
        if (bound?.database_path !== this.databasePath)
          throw new Error("attachment_database_root_conflict");
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
    let kernelLock: SqliteDatabase | undefined;
    return withAttachmentCleanup(
      async () => {
        kernelLock = this.openKernelLock(digest);
        while (!acquired) {
          let locked = false;
          try {
            // EXCLUSIVE mode retains the file lock after COMMIT, without an open transaction.
            kernelLock.exec("BEGIN EXCLUSIVE; COMMIT;");
            locked = true;
          } catch (error) {
            if (!(error instanceof Error && "errcode" in error && error.errcode === 5)) throw error;
          }
          if (locked)
            acquired = inWriteTransaction(claims, () => {
              const raw = claims
                .prepare("SELECT * FROM attachment_digest_claims WHERE digest=?")
                .get(digest);
              if (raw) {
                const owner = claimSchema.parse(raw);
                if (owner.coordination_version !== 1)
                  throw new Error(
                    "attachment_digest_legacy_owner_unverified: stop all old instances, drain protected operations; only recover offline after confirming every old owner has stopped"
                  );
                claims
                  .prepare("DELETE FROM attachment_digest_claims WHERE digest=? AND owner_token=?")
                  .run(digest, owner.owner_token);
              }
              claims
                .prepare(`INSERT INTO attachment_digest_claims
                (digest,owner_token,process_id,hostname,process_instance,coordination_version)
                VALUES(?,?,?,?,?,1)`)
                .run(digest, token, process.pid, hostname(), processInstance);
              return true;
            });
          if (!acquired) {
            if (performance.now() >= deadline) throw new Error("attachment_digest_wait_timeout");
            await delay(10);
          }
        }
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
            await withAttachmentCleanup(
              async () => claims.close(),
              async () => kernelLock?.close()
            );
          }
        );
      }
    );
  }

  private openKernelLock(digest: string): SqliteDatabase {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    // Never unlink these files: replacing their inode could admit two owners of one digest.
    const path = join(this.lockDirectory, `${digest}.sqlite`);
    const database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      database.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=0;");
      return database;
    } catch (error) {
      try {
        database.close();
      } catch (cleanup) {
        throw withAttachmentCleanupFailure(error, cleanup);
      }
      throw error;
    }
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
      try {
        database.close();
      } catch (cleanup) {
        throw withAttachmentCleanupFailure(error, cleanup);
      }
      throw error;
    }
  }
}
