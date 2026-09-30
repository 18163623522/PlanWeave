import { randomUUID } from "node:crypto";
import {
  createServer,
  IncomingMessage,
  ServerResponse,
  type Server as HttpServer
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerConfig } from "../../server/src/config.js";
import { hashOperatorToken } from "../../server/src/operatorAuth.js";
import { seedOperatorSessions } from "../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../server/src/serverComposition.js";
import { openServerDatabase } from "../../server/src/sqlite.js";
import { AgentHostRepository } from "../../server/src/hosts.js";
import { RemoteAgentRepository } from "../../server/src/remoteAgent/repository.js";
import { WorkspaceIdentityRepository } from "../../server/src/identity/workspaceRepository.js";

const smokeAdminToken = `pw_operator_${"M".repeat(43)}`;

export type CollaborationSmokeFixture = {
  origin: string;
  projectId: string;
  operatorToken: string;
  controlOrigin: string;
  controlKey: string;
  close: () => Promise<void>;
};

type FixtureInput = {
  projectRoot: string;
  projectId: string;
};

async function listen(server: HttpServer): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("collaboration_smoke_server_address_missing");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

/**
 * Starts the same HTTP + human-observer WebSocket composition used by the
 * collaboration server tests. The fixture is held by the smoke parent process
 * while the real Electron renderer connects through its typed bridge.
 */
export async function startCollaborationSmokeFixture(
  input: FixtureInput
): Promise<CollaborationSmokeFixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-desktop-collaboration-server-"));
  const httpServer = createServer();
  const controlKey = randomUUID();
  let failNextWorkspacePicker = false;
  const requestCounts = { inventory: 0, picker: 0, members: 0 };
  const originalEmit = httpServer.emit.bind(httpServer);
  httpServer.emit = (event: string | symbol, ...args: unknown[]) => {
    if (
      event === "request" &&
      args[0] instanceof IncomingMessage &&
      args[1] instanceof ServerResponse
    ) {
      const request = args[0];
      const response = args[1];
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path === "/api/v1/remote-agents")
        requestCounts.inventory += 1;
      if (request.method === "GET" && path === "/api/v1/workspace-connection") {
        requestCounts.picker += 1;
        if (failNextWorkspacePicker) {
          failNextWorkspacePicker = false;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "smoke_workspace_picker_unavailable" }));
          return true;
        }
      }
      if (request.method === "GET" && path === "/api/v1/workspace-connection/members")
        requestCounts.members += 1;
    }
    return originalEmit(event, ...args);
  };
  let composition: DistributedServerComposition | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let controlClose: (() => Promise<void>) | undefined;

  try {
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId: "desktop-smoke-workspace",
          projectId: input.projectId,
          canvasId: "default",
          projectRoot: input.projectRoot
        }
      ],
      operatorCredentials: [
        {
          operatorId: "desktop-smoke-admin",
          tokenSha256: hashOperatorToken(smokeAdminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    composition = await createDistributedServerComposition({
      httpServer,
      config
    });
    await seedOperatorSessions(config.databasePath, config.operatorCredentials);
    const listening = await listen(httpServer);
    serverClose = listening.close;
    const controlServer = createServer(async (request, response) => {
      if (request.headers["x-smoke-control-key"] !== controlKey) {
        response.writeHead(403).end();
        return;
      }
      try {
        if (request.method === "POST" && request.url === "/seed-remote") {
          const database = await openServerDatabase(config.databasePath, 5_000);
          try {
            const owner = database
              .prepare(
                "SELECT workspace_id,human_principal_id FROM workspace_memberships WHERE role='owner' AND revoked_at IS NULL LIMIT 1"
              )
              .get() as { workspace_id: string; human_principal_id: string } | undefined;
            if (!owner) throw new Error("smoke_owner_membership_missing");
            const now = new Date().toISOString();
            const identity = new WorkspaceIdentityRepository(database);
            for (let index = 0; index < 100; index += 1) {
              const workspaceId = identity.ensureWorkspaceForLegacyProject(`smoke-page-${index}`);
              database
                .prepare(
                  "INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
                )
                .run(workspaceId, owner.human_principal_id, "Desktop smoke owner", now);
              database
                .prepare(
                  `INSERT INTO workspace_memberships(
                  workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
                ) VALUES(?,?,?,?,1,?,?,NULL)`
                )
                .run(
                  workspaceId,
                  `smoke-membership-${index}`,
                  owner.human_principal_id,
                  "member",
                  now,
                  now
                );
            }
            const hosts = new AgentHostRepository(database);
            const host = hosts.register("Desktop smoke Host").host;
            const remote = new RemoteAgentRepository(database);
            const agent = remote.registerOrRestoreFromProfile({
              hostId: host.id,
              profileId: "desktop-smoke-codex",
              agentId: "codex",
              displayName: "Desktop smoke remote Codex",
              now,
              ownerHumanPrincipalId: owner.human_principal_id,
              accessMode: "workspace_restricted",
              allowOwnerCanvas: true
            });
            remote.grantWorkspace({
              endpointId: agent.endpointId,
              workspaceId: owner.workspace_id,
              grantedByHumanPrincipalId: owner.human_principal_id
            });
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ endpointId: agent.endpointId, workspaceId: owner.workspace_id })
            );
          } finally {
            database.close();
          }
          return;
        }
        if (request.method === "POST" && request.url === "/fail-next-workspace-picker") {
          failNextWorkspacePicker = true;
          response.writeHead(204).end();
          return;
        }
        if (request.method === "GET" && request.url === "/counts") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(requestCounts));
          return;
        }
        response.writeHead(404).end();
      } catch (error) {
        console.error("Collaboration smoke control request failed.", error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "smoke_control_request_failed" }));
      }
    });
    const control = await listen(controlServer);
    controlClose = control.close;

    return {
      origin: listening.origin,
      projectId: input.projectId,
      operatorToken: smokeAdminToken,
      controlOrigin: control.origin,
      controlKey,
      close: async () => {
        await controlClose?.();
        controlClose = undefined;
        await composition?.close();
        composition = undefined;
        await serverClose?.();
        serverClose = undefined;
        await rm(dataDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    try {
      await controlClose?.();
      await composition?.close();
    } finally {
      await serverClose?.();
      await rm(dataDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
