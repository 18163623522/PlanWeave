import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openServerDatabase } from "../sqlite.js";
import { AttachmentProcessHarness } from "./support/commentAttachmentProcessHarness.js";
import {
  auth,
  setup,
  bootstrap,
  createPending,
  uploadPending,
  finalizePending
} from "./support/commentAttachmentHttpFixture.js";

const bytes = Buffer.from("real process original attachment bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
async function pending(origin: string, token: string) {
  const created = await createPending(origin, token, "project-a", {
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    expectedDigestSha256: digest,
    ttlMs: 60_000
  });
  expect(created.response.status).toBe(201);
  return created.payload.pendingUploadId as string;
}
async function download(origin: string, token: string, id: string, directory: string) {
  expect((await finalizePending(origin, token, "project-a", id, digest)).response.status).toBe(200);
  const response = await fetch(`${origin}/api/v1/projects/project-a/attachments/pending/${id}`, {
    headers: auth(token)
  });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(
    await readFile(join(directory, "comment-attachments", "sha256", digest.slice(0, 2), digest))
  ).toEqual(bytes);
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("comment attachment multi-process lifecycle", () => {
  it("serializes independent HTTP instances on the same digest and preserves uploaded bytes", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const old = await pending(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", old, bytes, "text/plain", digest);
    now = new Date(now.getTime() + 120_000);
    const next = await pending(stack.origin, token);
    const child = new AttachmentProcessHarness({
      directory: stack.directory,
      now: now.toISOString(),
      mode: "hold-gc"
    });
    let cleaning: Promise<Response> | undefined;
    let uploading: ReturnType<typeof uploadPending> | undefined;
    const attempted = signal();
    const original = stack.lifecycle.withDigest.bind(stack.lifecycle);
    const spy = vi
      .spyOn(stack.lifecycle, "withDigest")
      .mockImplementation(async <T>(sha: string, action: () => Promise<T>) => {
        attempted.resolve();
        return original(sha, action);
      });
    try {
      const origin = await child.ready();
      cleaning = fetch(`${origin}/api/v1/projects/project-a/attachments/cleanup`, {
        method: "POST",
        headers: auth(token)
      });
      await child.waitFor("gc-held");
      uploading = uploadPending(
        stack.origin,
        token,
        "project-a",
        next,
        bytes,
        "text/plain",
        digest
      );
      await attempted.promise;
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", next).status
      ).toBe("pending");
      const other = await openServerDatabase(
        join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
        5000
      );
      try {
        expect(
          other
            .prepare("SELECT process_id FROM attachment_digest_claims WHERE digest=?")
            .get(digest)?.process_id
        ).not.toBe(process.pid);
      } finally {
        other.close();
      }
      child.release();
      const response = await cleaning;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removedPending: 1, removedBlobs: 1 });
      expect((await uploading).response.status).toBe(201);
      await download(origin, token, next, stack.directory);
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", next).status
      ).toBe("finalized");
      expect(stack.blobs.get(digest)?.sizeBytes).toBe(bytes.length);
    } finally {
      spy.mockRestore();
      await child.dispose();
      await Promise.allSettled([cleaning, uploading].filter((value) => value !== undefined));
    }
  }, 20000);

  it("recovers a killed publishing owner and finishes through a restarted HTTP instance", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const id = await pending(stack.origin, token);
    const child = new AttachmentProcessHarness({
      directory: stack.directory,
      now: now.toISOString(),
      mode: "hold-publish"
    });
    let restarted: AttachmentProcessHarness | undefined;
    let uploading: Promise<unknown> | undefined;
    try {
      const origin = await child.ready();
      uploading = uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest).catch(
        (error: unknown) => error
      );
      await child.waitFor("publish-held");
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", id).status
      ).toBe("pending");
      expect(stack.blobs.get(digest)?.sizeBytes).toBe(bytes.length);
      expect(
        await readFile(
          join(stack.directory, "comment-attachments", "sha256", digest.slice(0, 2), digest)
        )
      ).toEqual(bytes);
      await child.crash();
      await uploading;
      restarted = new AttachmentProcessHarness({
        directory: stack.directory,
        now: now.toISOString(),
        mode: "normal"
      });
      const recoveredOrigin = await restarted.ready();
      expect(
        (await uploadPending(recoveredOrigin, token, "project-a", id, bytes, "text/plain", digest))
          .response.status
      ).toBe(201);
      await download(recoveredOrigin, token, id, stack.directory);
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", id).status
      ).toBe("finalized");
      const claims = await openServerDatabase(
        join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
        5000
      );
      try {
        expect(
          claims.prepare("SELECT count(*) AS count FROM attachment_digest_claims").get()?.count
        ).toBe(0);
      } finally {
        claims.close();
      }
    } finally {
      await child.dispose();
      await restarted?.dispose();
      await uploading;
    }
  }, 20000);
});
