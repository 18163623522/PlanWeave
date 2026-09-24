import { clipboard, type BrowserWindow } from "electron";

export async function runManagementAuthorizationSmoke(
  window: BrowserWindow
): Promise<Record<string, unknown>> {
  const serverBaseUrl = process.env.PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL;
  const operatorToken = process.env.PLANWEAVE_DESKTOP_SMOKE_OPERATOR_TOKEN;
  if (!serverBaseUrl || !operatorToken) {
    throw new Error("Management smoke fixture configuration is incomplete.");
  }
  const priorClipboardText = clipboard.readText();
  clipboard.writeText(operatorToken);
  try {
    return (await window.webContents.executeJavaScript(`
      (async () => {
        const bridge = window.planweaveOperatorControl;
        if (!bridge) throw new Error("Typed operator bridge is unavailable.");
        const waitFor = async (predicate, label) => {
          for (let attempt = 0; attempt < 160; attempt += 1) {
            const value = await predicate();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Timed out waiting for " + label);
        };
        const profileId = "desktop-smoke-management";
        await bridge.upsertOperatorProfile({
          profileId,
          displayName: "Desktop smoke management",
          serverBaseUrl: ${JSON.stringify(serverBaseUrl)},
          allowInsecureTransport: true,
          operatorId: "desktop-smoke-admin"
        });
        document.querySelector('[data-testid="sidebar-settings"]')?.click();
        await waitFor(() => document.querySelector('[data-testid="settings-nav-connections"]'), "Connections navigation");
        document.querySelector('[data-testid="settings-nav-connections"]')?.click();
        await waitFor(() => document.querySelector('[data-testid="settings-connections-section"]'), "Connections settings");
        document.querySelector('[data-testid="settings-connections-tab-server"]')?.click();
        const row = await waitFor(
          () => [...document.querySelectorAll('[data-testid="server-connection-row"]')]
            .find((element) => element.textContent?.includes(${JSON.stringify(serverBaseUrl)})),
          "remembered Server row"
        );
        const restore = await waitFor(
          () => [...row.querySelectorAll('button')].find((button) =>
            /Restore|恢复/.test(button.textContent ?? "")
          ),
          "management restore action"
        );
        restore.click();
        const identity = await waitFor(
          () => document.querySelector('[data-testid="management-server-identity"]'),
          "management identity"
        );
        if (!identity.textContent?.includes(${JSON.stringify(serverBaseUrl)})) {
          throw new Error("Management dialog showed a different Server origin.");
        }
        const dialog = identity.closest('[role="dialog"]');
        if (!dialog) throw new Error("Management dialog is unavailable.");
        const advanced = [...dialog.querySelectorAll('summary')].find((summary) =>
          /Advanced|高级/.test(summary.textContent ?? "")
        );
        if (!advanced) throw new Error("Management import section is unavailable.");
        advanced.click();
        const importAction = await waitFor(
          () => [...dialog.querySelectorAll('button')].find((button) =>
            /Import|导入/.test(button.textContent ?? "")
          ),
          "management import action"
        );
        importAction.click();
        const authorization = await waitFor(
          async () => {
            const view = await bridge.getManagementAuthorization({ profileId });
            return view.authorization && view.deviceId && view.devices?.some((device) =>
              device.deviceId === view.deviceId && !device.revokedAt
            ) ? view : null;
          },
          "Server-backed management authorization"
        );
        await waitFor(
          () => dialog.textContent?.includes(authorization.devices.find((device) =>
            device.deviceId === authorization.deviceId
          ).deviceName),
          "remembered device in Chromium"
        );
        const serverDeviceCount = authorization.devices.filter((device) => !device.revokedAt).length;
        const statusAfterImport = await bridge.getOperatorControlStatus();
        if (!statusAfterImport.profiles.find((profile) => profile.profileId === profileId)?.hasOperatorCredential) {
          throw new Error("Operator credential was not persisted in isolated Desktop status.");
        }
        await bridge.clearOperatorCredential({ profileId });
        const statusAfterClear = await bridge.getOperatorControlStatus();
        if (statusAfterClear.profiles.find((profile) => profile.profileId === profileId)?.hasOperatorCredential) {
          throw new Error("Typed IPC did not clear the isolated operator credential.");
        }
        try {
          await waitFor(
            () => !dialog.textContent?.includes(authorization.devices.find((device) =>
              device.deviceId === authorization.deviceId
            ).deviceName) &&
            dialog.querySelector('[role="alert"]') !== null,
            "old device to disappear from Chromium after credential clear"
          );
        } catch (error) {
          throw new Error(String(error) + ": " + JSON.stringify({
            devicePresent: dialog.textContent?.includes(authorization.devices.find((device) =>
              device.deviceId === authorization.deviceId
            ).deviceName),
            buttons: [...dialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
            alerts: [...dialog.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.trim())
          }));
        }
        dialog.querySelector('[data-testid="management-dialog-close"]')?.click();
        document.querySelector('[data-testid="settings-back-to-app"]')?.click();
        return {
          profileBoundToServer: true,
          importTriggeredThroughUi: true,
          serverAuthorization: true,
          serverDeviceCount,
          deviceVisibleBeforeClear: true,
          credentialClearedThroughTypedIpc: true,
          oldDeviceHiddenAfterClear: true,
          serverDeviceRevoked: false
        };
      })()
    `)) as Record<string, unknown>;
  } finally {
    clipboard.writeText(priorClipboardText);
  }
}
