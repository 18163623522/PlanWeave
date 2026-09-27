import { MonitorIcon, ShieldCheckIcon } from "lucide-react";
import { ManagementDialog } from "../components/ManagementDialog";
import { type ReactNode, useEffect, useState } from "react";
import { useServerManagementAuthorization } from "../hooks/useServerManagementAuthorization";
import type { OperatorControlStatusSnapshot } from "../hooks/useOperatorControlStatusSnapshot";
import { Button } from "@/components/ui/button";
import { operatorControlBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { serverProfileLabel } from "./serverProfileLabel";
import { formatHostAdministrationError } from "./hostAdministrationErrors";

export function ServerManagementAuthorization({
  serverOrigin,
  operatorStatus,
  children,
  t
}: {
  serverOrigin: string;
  operatorStatus: OperatorControlStatusSnapshot;
  children: (access: {
    label: string | null;
    recoveryNeeded: boolean;
    disabled: boolean;
    open: () => void;
  }) => ReactNode;
  t: ReturnType<typeof createTranslator>;
}) {
  const {
    status,
    identityGeneration,
    profiles,
    profileId,
    profile,
    busy,
    checking,
    management,
    error,
    verifiedId,
    importCredential,
    reauthorize,
    recover,
    revoke,
    selectProfile,
    refresh
  } = useServerManagementAuthorization(serverOrigin, operatorStatus);
  const [open, setOpen] = useState(false);
  const [revokeDraft, setRevokeDraft] = useState<{
    generation: number;
    value: string | null;
  } | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<{
    generation: number;
    value: string;
  } | null>(null);
  const revokeId = revokeDraft?.generation === identityGeneration ? revokeDraft.value : null;
  const recoveryCode = recoveryDraft?.generation === identityGeneration ? recoveryDraft.value : "";
  const setRevokeId = (value: string | null) =>
    setRevokeDraft({ generation: identityGeneration, value });
  const setRecoveryCode = (value: string) =>
    setRecoveryDraft({ generation: identityGeneration, value });
  useEffect(() => {
    if (revokeDraft && revokeDraft.generation !== identityGeneration) setRevokeDraft(null);
    if (recoveryDraft && recoveryDraft.generation !== identityGeneration) setRecoveryDraft(null);
  }, [identityGeneration, recoveryDraft, revokeDraft]);
  const displayedError =
    error ??
    management?.errorCode ??
    (profile && !profile.hasOperatorCredential ? "operator_credential_missing" : null);
  const endpointUnavailable = displayedError === "operator_management_upgrade_required";
  const recoveryNeeded = [
    "operator_management_recovery_required",
    "operator_unauthorized",
    "operator_credential_missing",
    "operator_device_revoked"
  ].includes(displayedError ?? "");
  const authorized = Boolean(management?.authorization && !displayedError);
  const stateText = operatorStatus.loading
    ? t("serverManagementChecking")
    : status && profiles.length === 0
      ? t("serverManagementEmpty")
      : checking
        ? t("serverManagementChecking")
        : authorized
          ? t("serverManagementAdministrator")
          : recoveryNeeded
            ? t("serverManagementNeedsRecovery")
            : endpointUnavailable
              ? t("serverManagementUpgradeRequired")
              : t("serverManagementUnavailable");
  const quotedOperatorId = `'${(profile?.operatorId ?? "<operator-id>").replace(/'/g, "'\\''")}'`;
  return (
    <>
      {children({
        label: profile || operatorStatus.loading || operatorStatus.error ? stateText : null,
        recoveryNeeded,
        disabled: !profile || checking,
        open: () => setOpen(true)
      })}
      <ManagementDialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setRecoveryCode("");
            setRevokeId(null);
          }
        }}
        title={t("serverManagementAuthorization")}
        t={t}
      >
        <div className="flex flex-col gap-5">
          {authorized ? (
            <div role="status" className="flex items-start gap-3 rounded-lg bg-surface-muted p-4">
              <ShieldCheckIcon
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-text-strong"
              />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-text-strong">
                  {t("serverManagementAutomatic")}
                </p>
                <p className="text-xs leading-relaxed text-text-muted">
                  {t(
                    profile?.operatorCredentialPersistence === "session-only"
                      ? "serverManagementSessionOnly"
                      : management?.deviceId
                        ? "serverManagementDeviceRemembered"
                        : "serverManagementLegacy"
                  )}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm leading-relaxed text-text-muted">
              {t("serverManagementAuthorizationHint")}
            </p>
          )}
          {!operatorControlBridge ? <p role="alert">{t("hostAdminBridgeUnavailable")}</p> : null}
          {status && profiles.length === 0 ? <p>{t("serverManagementEmpty")}</p> : null}
          {profiles.length > 1 ? (
            <select
              aria-label={t("serverManagementAuthorization")}
              value={profileId ?? ""}
              disabled={busy || checking}
              className="max-w-full rounded-md border border-border bg-background p-2 text-sm"
              onChange={(event) => {
                setRecoveryCode("");
                selectProfile(event.target.value);
                setRevokeId(null);
              }}
            >
              <option value="" disabled>
                {t("settingsServer")}
              </option>
              {profiles.map((item) => (
                <option key={item.profileId} value={item.profileId}>
                  {serverProfileLabel(item, t)} · {item.operatorId} · {item.profileId.slice(-6)}
                </option>
              ))}
            </select>
          ) : null}
          {profile ? (
            <dl
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs"
              data-testid="management-server-identity"
            >
              <dt className="text-text-muted">{t("settingsServer")}</dt>
              <dd className="break-all">{profile.serverBaseUrl}</dd>
              <dt className="text-text-muted">{t("serverManagementAdministratorId")}</dt>
              <dd className="break-all">{profile.operatorId}</dd>
            </dl>
          ) : null}
          {checking ? (
            <p role="status" className="text-sm text-text-muted">
              {t("serverManagementChecking")}
            </p>
          ) : null}
          {!authorized ? (
            <Button
              className="w-fit"
              disabled={!profile || busy || checking || endpointUnavailable}
              onClick={() => void reauthorize()}
            >
              {busy ? t("serverManagementWorking") : t("serverManagementReauthorize")}
            </Button>
          ) : null}
          {!authorized ? (
            <p className="text-xs text-text-muted">{t("serverManagementReauthorizeHint")}</p>
          ) : null}
          {displayedError ? (
            <p role="alert" className="text-sm text-destructive">
              {formatHostAdministrationError(
                displayedError === "operator_unauthorized"
                  ? "operator_management_recovery_required"
                  : displayedError,
                t
              )}
            </p>
          ) : null}
          {displayedError && !endpointUnavailable ? (
            <Button
              className="w-fit"
              variant="outline"
              disabled={!profile || busy || checking}
              onClick={refresh}
            >
              {t("serverManagementCheckAgain")}
            </Button>
          ) : null}
          {endpointUnavailable ? (
            <div
              className="rounded-md border border-border/70 p-3 text-sm"
              data-testid="management-upgrade-guide"
            >
              <h3 className="font-medium">{t("serverManagementUpgradeTitle")}</h3>
              <p className="mt-2 text-text-muted">
                {t(
                  profile?.hostedByThisDesktop
                    ? "serverManagementUpgradeLocal"
                    : "serverManagementUpgradeRemote"
                )}
              </p>
              <ol className="my-3 list-decimal space-y-2 pl-5 text-text-muted">
                <li>{t("serverManagementUpgradeDeploy")}</li>
                <li>{t("serverManagementUpgradeProxy")}</li>
                <li>{t("serverManagementUpgradeThenAuthorize")}</li>
              </ol>
              <Button variant="outline" disabled={!profile || busy || checking} onClick={refresh}>
                {t("serverManagementCheckAgain")}
              </Button>
            </div>
          ) : null}
          {!authorized && !endpointUnavailable ? (
            <details
              key={profileId}
              open={recoveryNeeded || Boolean(recoveryCode) || undefined}
              className="border-t border-border/70 pt-3"
            >
              <summary className="cursor-pointer text-sm">{t("serverManagementRecovery")}</summary>
              <p className="my-3 text-sm text-text-muted">{t("serverManagementRecoveryHint")}</p>
              <p className="mb-1 text-xs text-text-muted">Docker Compose</p>
              <code className="block break-all rounded bg-surface-muted p-3 text-xs">
                docker compose exec server node /app/dist/bin.js auth recover --operator{" "}
                {quotedOperatorId}
              </code>
              <p className="mb-1 mt-2 text-xs text-text-muted">{t("serverManagementStandalone")}</p>
              <code className="block break-all rounded bg-surface-muted p-3 text-xs">
                planweave-server auth recover --config /path/to/server.json --operator{" "}
                {quotedOperatorId}
              </code>
              <form
                className="mt-3 flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void recover(recoveryCode.trim()).then((success) => {
                    if (success) setRecoveryCode("");
                  });
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={recoveryCode}
                  aria-label={t("serverManagementRecoveryCode")}
                  placeholder={t("serverManagementRecoveryCode")}
                  disabled={busy || endpointUnavailable}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background p-2 text-sm"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    !profile || busy || checking || endpointUnavailable || !recoveryCode.trim()
                  }
                >
                  {t("serverManagementRecover")}
                </Button>
              </form>
            </details>
          ) : null}
          {authorized && management?.devices ? (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">{t("serverManagementDevices")}</h3>
              <p className="text-xs leading-relaxed text-text-muted">
                {t("serverManagementDevicesHint")}
              </p>
              {management.devices
                .filter((device) => !device.revokedAt)
                .map((device) => (
                  <div
                    key={device.deviceId}
                    className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-muted/60 p-3"
                  >
                    <MonitorIcon aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
                    <div className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="min-w-0 break-all font-medium">{device.deviceName}</p>
                        {device.deviceId === management.deviceId ? (
                          <span className="shrink-0 rounded bg-background px-2 py-0.5 text-xs text-text-muted">
                            {t("serverManagementThisDevice")}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-text-muted">
                        {t("serverManagementLastUsed")}{" "}
                        {new Date(device.lastUsedAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRevokeId(device.deviceId)}
                    >
                      {t("serverManagementRevoke")}
                    </Button>
                  </div>
                ))}
              {revokeId ? (
                <div className="mt-3 rounded border border-border p-3">
                  <p className="mb-3 text-sm">{t("serverManagementRevokeConfirm")}</p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void revoke(revokeId).then((success) => {
                          if (success) setRevokeId(null);
                        })
                      }
                    >
                      {t("serverManagementRevoke")}
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setRevokeId(null)}>
                      {t("accessCancelChanges")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <details className="border-t border-border/70 pt-4">
            <summary className="cursor-pointer text-xs text-text-muted hover:text-text-strong">
              {t("serverManagementAdvanced")}
            </summary>
            <p className="my-3 text-sm text-text-muted">{t("serverManagementImportHint")}</p>
            <Button
              className="w-fit"
              variant="outline"
              disabled={!profile || busy || checking}
              onClick={() => void importCredential()}
            >
              {t("serverManagementImport")}
            </Button>
          </details>
          {profile && verifiedId === profile.profileId ? (
            <p role="status" className="text-sm">
              {t(
                profile.operatorCredentialPersistence === "session-only"
                  ? "serverManagementSessionOnly"
                  : "serverManagementVerified"
              )}
            </p>
          ) : null}
        </div>
      </ManagementDialog>
    </>
  );
}
