import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileOAuthTokenStore,
  type StoredAccessToken,
  type StoredOAuthToken,
  type StoredRefreshToken
} from "../oauthTokenStore.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    stat: vi.fn(actual.stat),
    chmod: vi.fn(actual.chmod),
    rename: vi.fn(actual.rename)
  };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const tempDirs: string[] = [];
const supportsPosixModeAssertions = process.platform !== "win32";

afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  vi.mocked(stat).mockReset();
  vi.mocked(chmod).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-oauth-token-store-"));
  tempDirs.push(dir);
  return join(dir, "config", "oauth", "tokens.json");
}

function createBarrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function accessToken(overrides: Partial<StoredAccessToken> = {}): StoredAccessToken {
  return {
    kind: "access",
    tokenHash: "token-a",
    clientId: "client-a",
    expiresAt: Date.now() + 60_000,
    resource: "http://127.0.0.1:8787/mcp",
    scope: "planweave:mcp",
    ...overrides
  };
}

function refreshToken(overrides: Partial<StoredRefreshToken> = {}): StoredRefreshToken {
  return {
    kind: "refresh",
    tokenHash: "refresh-a",
    clientId: "client-a",
    expiresAt: Date.now() + 60_000,
    resource: "http://127.0.0.1:8787/mcp",
    scope: "planweave:mcp offline_access",
    ...overrides
  };
}

async function readStoredTokens(path: string): Promise<{ version: 2; tokens: StoredOAuthToken[] }> {
  return JSON.parse(await readFile(path, "utf8")) as { version: 2; tokens: StoredOAuthToken[] };
}

async function expectPrivateStorePermissions(path: string): Promise<void> {
  if (!supportsPosixModeAssertions) {
    return;
  }
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}

describe("file OAuth token store", () => {
  it.each(["ENOSPC", "EACCES"])("recovers reads and refresh mutations after %s", async (code) => {
    const path = await createTempStorePath();
    const store = createFileOAuthTokenStore(path);
    const previous = refreshToken();
    const unpublished = accessToken({ tokenHash: "unpublished" });
    await store.set(previous);
    const failure = Object.assign(new Error("injected write failure"), { code });
    vi.mocked(writeFile).mockRejectedValueOnce(failure);

    await expect(store.replace(previous.tokenHash, [unpublished])).rejects.toBe(failure);
    await expect(store.get(previous.tokenHash)).resolves.toEqual(previous);
    await expect(store.get(unpublished.tokenHash)).resolves.toBeUndefined();
    await expect(createFileOAuthTokenStore(path).get(previous.tokenHash)).resolves.toEqual(
      previous
    );
    await expect(store.replace(previous.tokenHash, [unpublished])).resolves.toEqual(previous);
    await expect(store.get(unpublished.tokenHash)).resolves.toEqual(unpublished);
    await expect(createFileOAuthTokenStore(path).get(unpublished.tokenHash)).resolves.toEqual(
      unpublished
    );
  });

  it("waits for queued writes and publishes only the successful snapshot", async () => {
    const path = await createTempStorePath();
    const store = createFileOAuthTokenStore(path);
    await store.set(accessToken());
    const failure = new Error("injected first write failure");
    const firstEntered = createBarrier();
    const releaseFirst = createBarrier();
    const secondEntered = createBarrier();
    const releaseSecond = createBarrier();
    vi.mocked(writeFile)
      .mockImplementationOnce(async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw failure;
      })
      .mockImplementationOnce(async (...args) => {
        secondEntered.resolve();
        await releaseSecond.promise;
        await actualFs.writeFile(...args);
      });
    const first = store.set(accessToken({ tokenHash: "failed" }));
    const firstRejected = expect(first).rejects.toBe(failure);
    await firstEntered.promise;
    const second = store.set(accessToken({ tokenHash: "successful" }));
    let readSettled = false;
    const read = store.get("successful").then((token) => {
      readSettled = true;
      return token;
    });
    releaseFirst.resolve();
    await secondEntered.promise;
    expect(readSettled).toBe(false);
    await expect(createFileOAuthTokenStore(path).get("successful")).resolves.toBeUndefined();
    releaseSecond.resolve();
    await firstRejected;
    await second;
    await expect(read).resolves.toMatchObject({ tokenHash: "successful" });
    await expect(store.get("failed")).resolves.toBeUndefined();
    expect(await readStoredTokens(path)).toMatchObject({
      tokens: [{ tokenHash: "successful" }, { tokenHash: "token-a" }]
    });
  });

  it.each([
    "write",
    "stat",
    "chmod",
    "rename"
  ] as const)("preserves the committed file and cleans temporary files on %s failure", async (stage) => {
    const path = await createTempStorePath();
    const store = createFileOAuthTokenStore(path);
    await store.set(accessToken());
    const committed = await readFile(path, "utf8");
    const failure = Object.assign(new Error(`injected ${stage} failure`), { code: "EACCES" });
    if (stage === "write") {
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        await actualFs.writeFile(...args);
        throw failure;
      });
    } else if (stage === "stat") {
      vi.mocked(stat).mockRejectedValueOnce(failure);
    } else if (stage === "chmod") {
      // Force a real mode correction on both POSIX and Windows fixtures.
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        await actualFs.writeFile(...args);
        await actualFs.chmod(String(args[0]), 0o644);
      });
      vi.mocked(stat).mockImplementationOnce(async (...args) => {
        const metadata = await actualFs.stat(...args);
        metadata.mode = 0o644;
        return metadata;
      });
      vi.mocked(chmod).mockImplementation(async (target, mode) => {
        if (String(target) !== dirname(path)) throw failure;
        await actualFs.chmod(target, mode);
      });
    } else {
      vi.mocked(rename).mockRejectedValueOnce(failure);
    }

    await expect(store.set(accessToken({ tokenHash: "unpublished" }))).rejects.toBe(failure);
    expect(await readFile(path, "utf8")).toBe(committed);
    expect(await readdir(dirname(path))).toEqual(["tokens.json"]);
    await expect(createFileOAuthTokenStore(path).get("unpublished")).resolves.toBeUndefined();
    await expect(store.get("unpublished")).resolves.toBeUndefined();
  });

  it.each([
    { version: 3, tokens: [] },
    { version: 2, tokens: [{ kind: "refresh" }] }
  ])("keeps invalid initialization visible to reads and writes: %j", async (value) => {
    const path = await createTempStorePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
    const store = createFileOAuthTokenStore(path);
    await expect(store.get("token-a")).rejects.toThrow("OAuth token store");
    await expect(store.set(accessToken())).rejects.toThrow("OAuth token store");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
  });

  it("does not consume an expired refresh token into replacements", async () => {
    const path = await createTempStorePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, tokens: [refreshToken({ expiresAt: 1 })] }));
    const store = createFileOAuthTokenStore(path);
    await expect(store.replace("refresh-a", [accessToken()])).resolves.toBeUndefined();
    expect(await readStoredTokens(path)).toEqual({ version: 2, tokens: [] });
  });

  it("writes tokens with private file and directory permissions", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthTokenStore(storePath);

    await store.set(accessToken({ tokenHash: "token-private" }));

    expect(await store.get("token-private")).toMatchObject({ clientId: "client-a" });
    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [{ kind: "access", tokenHash: "token-private" }]
    });
    await expectPrivateStorePermissions(storePath);
  });

  it("deletes requested and expired tokens while preserving private permissions", async () => {
    const storePath = await createTempStorePath();
    const storeDir = dirname(storePath);
    const now = Date.now();
    await mkdir(storeDir, { recursive: true, mode: 0o755 });
    if (supportsPosixModeAssertions) {
      await chmod(storeDir, 0o755);
    }
    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          tokens: [legacyAccessToken("expired-token", now - 1), legacyAccessToken("deleted-token")]
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o644 }
    );
    if (supportsPosixModeAssertions) {
      await chmod(storePath, 0o644);
    }
    const store = createFileOAuthTokenStore(storePath);

    await store.delete("deleted-token");

    expect(await readStoredTokens(storePath)).toEqual({ version: 2, tokens: [] });
    await expectPrivateStorePermissions(storePath);
  });

  it("keeps sorted, current content after repeated writes", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthTokenStore(storePath);

    await store.set(accessToken({ tokenHash: "token-b", clientId: "client-b" }));
    await store.set(accessToken({ tokenHash: "token-a", clientId: "client-a" }));
    await store.set(accessToken({ tokenHash: "token-b", clientId: "client-b-updated" }));

    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [
        { tokenHash: "token-a", clientId: "client-a" },
        { tokenHash: "token-b", clientId: "client-b-updated" }
      ]
    });
    await expectPrivateStorePermissions(storePath);
  });

  it("migrates version 1 access tokens without invalidating them", async () => {
    const storePath = await createTempStorePath();
    await mkdir(dirname(storePath), { recursive: true });
    const legacyToken = accessToken({ tokenHash: "legacy-access-token" });
    const { kind: _kind, ...legacyRecord } = legacyToken;
    await writeFile(
      storePath,
      `${JSON.stringify({ version: 1, tokens: [legacyRecord] }, null, 2)}\n`,
      "utf8"
    );
    const store = createFileOAuthTokenStore(storePath);

    await expect(store.get("legacy-access-token")).resolves.toMatchObject({
      kind: "access",
      clientId: "client-a"
    });
    await store.set(accessToken({ tokenHash: "new-access-token" }));

    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [
        { kind: "access", tokenHash: "legacy-access-token" },
        { kind: "access", tokenHash: "new-access-token" }
      ]
    });
  });

  it("atomically consumes one refresh token and persists its replacements", async () => {
    const storePath = await createTempStorePath();
    const store = createFileOAuthTokenStore(storePath);
    await store.setMany([
      refreshToken({ tokenHash: "refresh-old" }),
      accessToken({ tokenHash: "access-old" })
    ]);

    const [first, reused] = await Promise.all([
      store.replace("refresh-old", [
        refreshToken({ tokenHash: "refresh-new" }),
        accessToken({ tokenHash: "access-new" })
      ]),
      store.replace("refresh-old", [refreshToken({ tokenHash: "refresh-unexpected" })])
    ]);

    expect(first).toMatchObject({ kind: "refresh", tokenHash: "refresh-old" });
    expect(reused).toBeUndefined();
    expect(await readStoredTokens(storePath)).toMatchObject({
      version: 2,
      tokens: [
        { kind: "access", tokenHash: "access-new" },
        { kind: "access", tokenHash: "access-old" },
        { kind: "refresh", tokenHash: "refresh-new" }
      ]
    });
  });
});

function legacyAccessToken(tokenHash: string, expiresAt = Date.now() + 60_000) {
  const { kind: _kind, ...legacyToken } = accessToken({ tokenHash, expiresAt });
  return legacyToken;
}
