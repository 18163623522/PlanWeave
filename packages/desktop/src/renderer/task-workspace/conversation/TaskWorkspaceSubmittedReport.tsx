import type { DesktopRunRecord } from "@planweave-ai/runtime";
import type { createTranslator } from "../../i18n";
import { SafeMarkdown } from "../../inspector/SafeMarkdown";

export function TaskWorkspaceSubmittedReport({
  record,
  submittedAt,
  t
}: {
  record: DesktopRunRecord;
  submittedAt: string;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto p-5 pb-[calc(var(--task-workspace-composer-height,0px)+1.25rem)]"
      data-testid="task-workspace-submitted-report"
      data-record-id={record.recordId}
      data-record-ready="true"
    >
      <header className="text-sm">
        <p className="font-medium">{t("taskWorkspaceReportSubmitted")}</p>
        <time dateTime={submittedAt}>{new Date(submittedAt).toLocaleString()}</time>
        <p className="mt-2 text-text-muted">{t("taskWorkspaceReportOnly")}</p>
      </header>
      {record.reportPath !== null ? (
        <article className="rounded-xl border bg-background p-5 text-sm">
          <SafeMarkdown markdown={record.reportMarkdown} />
        </article>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {t("noRunReport")}
        </p>
      )}
    </section>
  );
}
