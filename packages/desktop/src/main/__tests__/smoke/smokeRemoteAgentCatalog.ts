import { clipboard, type BrowserWindow } from "electron";

type Counts = { inventory: number; picker: number; members: number };

async function control(path: string, method: "GET" | "POST" = "GET") {
  const origin = process.env.PLANWEAVE_DESKTOP_SMOKE_CONTROL_URL;
  const key = process.env.PLANWEAVE_DESKTOP_SMOKE_CONTROL_KEY;
  if (!origin || !key) throw new Error("Remote Agent smoke control fixture is unavailable.");
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "x-smoke-control-key": key }
  });
  if (!response.ok)
    throw new Error(`Remote Agent smoke control ${path} failed: ${response.status}`);
  return response;
}

async function counts(): Promise<Counts> {
  return (await (await control("/counts")).json()) as Counts;
}

async function reloadForLocale(window: BrowserWindow, language: "en" | "zh-CN"): Promise<void> {
  await window.webContents.executeJavaScript(`
    window.planweaveDesktopSettings.saveDesktopSettings({ language: ${JSON.stringify(language)} })
  `);
  await new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.reload();
  });
  await window.webContents.executeJavaScript(`
    (async () => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (document.querySelector('[data-testid="sidebar-executors"]')) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Localized collaboration shell did not load.");
    })()
  `);
}

export async function runRemoteAgentCatalogSmoke(
  window: BrowserWindow
): Promise<Record<string, unknown>> {
  const token = process.env.PLANWEAVE_DESKTOP_SMOKE_OPERATOR_TOKEN;
  if (!token) throw new Error("Remote Agent smoke operator token is unavailable.");
  const seeded = (await (await control("/seed-remote", "POST")).json()) as {
    endpointId: string;
    workspaceId: string;
  };
  const priorClipboardText = clipboard.readText();
  clipboard.writeText(token);
  try {
    await window.webContents.executeJavaScript(`
      (async () => {
        const bridge = window.planweaveOperatorControl;
        if (!bridge) throw new Error("Typed operator bridge is unavailable.");
        await bridge.importOperatorCredential({
          profileId: "desktop-smoke-management",
          verifyBeforeSave: true
        });
        await window.planweaveCollaboration?.recoverCollaborationIdentities({
          serverBaseUrl: ${JSON.stringify(process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL)},
          allowInsecureTransport: true
        });
        await bridge.setActiveOperatorProfile({ profileId: "desktop-smoke-management" });
        const status = await bridge.getOperatorControlStatus();
        if (!status.profiles.find((profile) => profile.profileId === status.activeProfileId)?.humanPrincipalId) {
          throw new Error("Remote Agent smoke owner Human identity was not recovered.");
        }
      })()
    `);
  } finally {
    clipboard.writeText(priorClipboardText);
  }
  const before = await counts();
  const inventory = (await window.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      document.querySelector('[data-testid="sidebar-executors"]')?.click();
      await waitFor(() => document.querySelector('[data-testid="executor-inventory"]'), "executor inventory");
      let row;
      try {
        row = await waitFor(
          () => [...document.querySelectorAll('[data-testid="executor-remote-row"]')].find(
            (element) => element.textContent?.includes("Desktop smoke remote Codex")
          ),
          "Server-backed remote Agent row"
        );
      } catch (error) {
        const operator = await window.planweaveOperatorControl?.getOperatorControlStatus();
        const collaboration = await window.planweaveCollaboration?.getCollaborationStatus();
        throw new Error(String(error) + ": " + JSON.stringify({
          activeOperator: operator?.activeProfileId,
          operatorHuman: operator?.profiles.find((profile) => profile.profileId === operator?.activeProfileId)?.humanPrincipalId,
          collaborationHuman: collaboration?.profiles.find((profile) => profile.profileId === collaboration?.activeProfileId)?.humanPrincipalId,
          inventory: document.querySelector('[data-testid="executor-inventory"]')?.textContent?.slice(0, 700)
        }));
      }
      if (!row.querySelector('button')) throw new Error("Remote Agent details action is missing.");
      return { rowVisible: true };
    })()
  `)) as { rowVisible: boolean };
  const afterInventory = await counts();
  if (afterInventory.inventory <= before.inventory || afterInventory.picker !== before.picker) {
    throw new Error("Remote inventory eagerly loaded management picker or did not reach Server.");
  }
  await control("/fail-next-workspace-picker", "POST");
  const errorState = (await window.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const row = [...document.querySelectorAll('[data-testid="executor-remote-row"]')].find(
        (element) => element.textContent?.includes("Desktop smoke remote Codex")
      );
      if (!row) throw new Error("Remote Agent disappeared before opening management details.");
      row.querySelector('button')?.click();
      const editor = await waitFor(
        () => document.querySelector('[data-testid="remote-agent-row-${seeded.endpointId}"]'),
        "remote Agent policy editor"
      );
      const error = await waitFor(
        () => editor.querySelector('[data-testid="remote-agent-catalog-error"]'),
        "isolated Workspace picker failure"
      );
      if (!document.querySelector('[data-testid="executor-remote-row"]')) {
        throw new Error("Directory error removed the remote inventory row.");
      }
      const retry = error.querySelector('button');
      if (!(retry instanceof HTMLButtonElement) || retry.disabled) {
        throw new Error("Workspace picker retry action is unavailable.");
      }
      if (!error.textContent?.includes("管理选项暂不可用") ||
          !retry.textContent?.includes("重试管理选项")) {
        throw new Error("Workspace picker failure did not use the selected Chinese locale.");
      }
      const accessMode = editor.querySelector('[data-testid="remote-agent-access-mode"]');
      const grantedSwitch = editor.querySelector('[data-testid="remote-agent-grant-workspace"] [role="switch"]');
      if (!(accessMode instanceof HTMLFieldSetElement) || accessMode.disabled ||
          !(grantedSwitch instanceof HTMLButtonElement) || grantedSwitch.disabled) {
        throw new Error("Directory failure incorrectly disabled existing Agent policy controls.");
      }
      retry.focus();
      return { errorVisible: true, locale: "zh-CN", grantControlEnabledDuringError: true };
    })()
  `)) as Record<string, unknown>;
  window.show();
  window.focus();
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  const firstPageCount = (await window.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      const editor = document.querySelector('[data-testid="remote-agent-row-${seeded.endpointId}"]');
      if (!editor) throw new Error("Remote Agent editor disappeared before keyboard retry.");
      await waitFor(
        () => !editor.querySelector('[data-testid="remote-agent-catalog-error"]') &&
          editor.querySelectorAll('[data-testid="remote-agent-grant-workspace"] label').length >= 100,
        "keyboard Workspace picker retry and first page"
      );
      const grantList = editor.querySelector('[data-testid="remote-agent-grant-workspace"]');
      const firstPageCount = grantList?.querySelectorAll('label').length ?? 0;
      const loadMore = [...editor.querySelectorAll('button')].find((button) =>
        /Load more|加载更多/.test(button.textContent ?? "")
      );
      if (!(loadMore instanceof HTMLButtonElement) || loadMore.disabled) {
        throw new Error("Workspace picker did not expose enabled second-page action.");
      }
      loadMore.focus();
      return firstPageCount;
    })()
  `)) as number;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  window.webContents.sendInputEvent({ type: "char", keyCode: " " });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  const catalog = (await window.webContents.executeJavaScript(`
    (async () => {
      const grantList = document.querySelector('[data-testid="remote-agent-row-${seeded.endpointId}"] [data-testid="remote-agent-grant-workspace"]');
      if (!grantList) throw new Error("Remote Agent grant list disappeared before keyboard pagination.");
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Timed out waiting for " + label);
      };
      await waitFor(
        () => (grantList?.querySelectorAll('label').length ?? 0) >= 101,
        "keyboard Workspace picker second page"
      );
      const labels = [...(grantList?.querySelectorAll('label') ?? [])].map((label) => label.textContent?.trim());
      if (new Set(labels).size !== labels.length) throw new Error("Workspace picker duplicated a row.");
      return { retrySucceeded: true, secondPageCount: labels.length, uniqueRows: true, detailsOpened: true };
    })()
  `)) as Record<string, unknown>;
  const afterCatalog = await counts();
  if (
    afterCatalog.inventory !== afterInventory.inventory ||
    afterCatalog.picker < afterInventory.picker + 3
  ) {
    throw new Error(
      "Directory retry/pagination unexpectedly refreshed inventory or skipped Server requests."
    );
  }
  await window.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-testid="management-dialog-close"]')?.click();
      return true;
    })()
  `);
  let englishErrorVerified = false;
  try {
    await reloadForLocale(window, "en");
    await control("/fail-next-workspace-picker", "POST");
    englishErrorVerified = (await window.webContents.executeJavaScript(`
      (async () => {
        const waitFor = async (predicate, label) => {
          for (let attempt = 0; attempt < 160; attempt += 1) {
            const value = predicate();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Timed out waiting for " + label);
        };
        document.querySelector('[data-testid="sidebar-executors"]')?.click();
        const row = await waitFor(
          () => [...document.querySelectorAll('[data-testid="executor-remote-row"]')].find(
            (element) => element.textContent?.includes("Desktop smoke remote Codex")
          ),
          "English remote Agent inventory row"
        );
        row.querySelector('button')?.click();
        const editor = await waitFor(
          () => document.querySelector('[data-testid="remote-agent-row-${seeded.endpointId}"]'),
          "English remote Agent policy editor"
        );
        const error = await waitFor(
          () => editor.querySelector('[data-testid="remote-agent-catalog-error"]'),
          "English Workspace picker failure"
        );
        const retry = error.querySelector('button');
        const accessMode = editor.querySelector('[data-testid="remote-agent-access-mode"]');
        const grantedSwitch = editor.querySelector('[data-testid="remote-agent-grant-workspace"] [role="switch"]');
        if (!error.textContent?.includes("Management options are unavailable") ||
            !(retry instanceof HTMLButtonElement) || retry.disabled ||
            !retry.textContent?.includes("Retry options") ||
            !(accessMode instanceof HTMLFieldSetElement) || accessMode.disabled ||
            !(grantedSwitch instanceof HTMLButtonElement) || grantedSwitch.disabled) {
          throw new Error("English Workspace picker failure or existing policy controls were inconsistent.");
        }
        return true;
      })()
    `)) as boolean;
  } finally {
    await reloadForLocale(window, "zh-CN");
  }
  return {
    ...inventory,
    ...errorState,
    ...catalog,
    firstPageCount,
    retryKeyboard: "Enter",
    loadMoreKeyboard: "Space",
    englishErrorVerified,
    serverEndpointId: seeded.endpointId,
    serverGrantWorkspaceId: seeded.workspaceId,
    inventoryRequests: afterCatalog.inventory - before.inventory,
    pickerRequestsBeforeEdit: afterInventory.picker - before.picker,
    pickerRequestsAfterEdit: afterCatalog.picker - afterInventory.picker,
    inventoryStableThroughCatalogError: true
  };
}
