import { rm } from "node:fs/promises";
import { PACKAGE_SNAPSHOT_MAX_RETAINED } from "@planweave-ai/collaboration-protocol/core/limits";
import { backingPath } from "./packageSnapshotBacking.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

type CleanupRow = { rowid: number; snapshot_id: string; state: string };

export async function enforcePackageSnapshotRetention(
  database: SqliteDatabase,
  dataDirectory: string,
  canvasRegistryId: string,
  at: string
): Promise<void> {
  const ceiling = Number(
    database
      .prepare(
        "SELECT COALESCE(MAX(rowid),0) AS maximum FROM package_snapshots WHERE canvas_registry_id=?"
      )
      .get(canvasRegistryId)?.maximum
  );
  const failures: unknown[] = [];
  let cursor = 0;
  while (cursor < ceiling) {
    const batch = inWriteTransaction(database, () => {
      // Pending rows still occupy their place in the newest window; older pins are extra.
      const boundary = database
        .prepare(
          "SELECT rowid FROM package_snapshots WHERE canvas_registry_id=? AND state='available' ORDER BY rowid DESC LIMIT 1 OFFSET ?"
        )
        .get(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED - 1);
      const cutoff = boundary ? Number(boundary.rowid) : 0;
      const rows = database
        .prepare(
          `SELECT rowid,snapshot_id,state FROM package_snapshots
         WHERE canvas_registry_id=? AND rowid>? AND rowid<=? AND restore_marker<>'restore_pending'
           AND (state='revoked' OR (state='available' AND rowid<?))
         ORDER BY rowid LIMIT ?`
        )
        .all(
          canvasRegistryId,
          cursor,
          ceiling,
          cutoff,
          PACKAGE_SNAPSHOT_MAX_RETAINED
        ) as CleanupRow[];
      const owned = rows.filter(
        (row) =>
          row.state === "revoked" ||
          database
            .prepare(
              `UPDATE package_snapshots SET state='revoked',revoked_at=?,updated_at=?,retention_order=NULL
         WHERE snapshot_id=? AND canvas_registry_id=? AND state='available'
           AND restore_marker<>'restore_pending' AND rowid<?`
            )
            .run(at, at, row.snapshot_id, canvasRegistryId, cutoff).changes === 1
      );
      return { rows, owned };
    });
    if (batch.rows.length === 0) break;
    cursor = batch.rows[batch.rows.length - 1]!.rowid;
    for (const row of batch.owned) {
      try {
        await rm(backingPath(dataDirectory, row.snapshot_id), { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
  }
  inWriteTransaction(database, () => {
    database
      .prepare(
        "UPDATE package_snapshots SET retention_order=NULL WHERE canvas_registry_id=? AND state='available'"
      )
      .run(canvasRegistryId);
    const retained = database
      .prepare(
        "SELECT snapshot_id FROM package_snapshots WHERE canvas_registry_id=? AND state='available' ORDER BY rowid DESC LIMIT ?"
      )
      .all(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED);
    retained.forEach((row, index) => {
      database
        .prepare(
          "UPDATE package_snapshots SET retention_order=?,updated_at=? WHERE snapshot_id=? AND canvas_registry_id=? AND state='available'"
        )
        .run(retained.length - index, at, row.snapshot_id, canvasRegistryId);
    });
  });
  if (failures.length > 0) throw new AggregateError(failures, "snapshot_retention_cleanup_failed");
}
