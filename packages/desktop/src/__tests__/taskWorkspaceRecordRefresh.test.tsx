/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { TaskWorkspaceRunDetail } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemo } from "react";
import { createTranslator } from "../renderer/i18n";
import { TaskWorkspaceConversation } from "../renderer/task-workspace/conversation";
import { useTaskWorkspaceRecordCache } from "../renderer/task-workspace/useTaskWorkspaceRecordCache";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  conversationProps,
  record,
  recordId,
  selection
} from "./helpers/taskWorkspaceConversationFixture";

const t = createTranslator("en");
const selected = selection({ runnerKind: "cli", model: null });
const onRecordReady = () => undefined;

function detail(markdown: string, id = recordId): TaskWorkspaceRunDetail {
  return {
    version: "planweave.task-workspace-run-detail/v1",
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    taskId: "T-001",
    blockRef: "T-001#B-001",
    item: {
      ...selected.item,
      run: { ...selected.item.run, record: { ...selected.item.run.record, recordId: id } }
    },
    record: record(null, { recordId: id, displayMarkdown: markdown })
  };
}

function harness(getTaskWorkspaceRunDetail: () => Promise<TaskWorkspaceRunDetail>) {
  const api = {
    getTaskWorkspaceRunDetail,
    detectTerminalApps: vi.fn(async () => []),
    getTerminalPreferences: vi.fn(async () => ({ defaultTerminalAppId: null }))
  };
  function Reader({
    freshnessKey,
    authorityKey = "authority-a",
    id = recordId
  }: {
    freshnessKey: string;
    authorityKey?: string;
    id?: string;
  }) {
    const identity = useMemo(
      () => ({
        projectRoot: "/projects/demo",
        canvasId: "canvas-main",
        taskId: "T-001",
        blockRef: "T-001#B-001",
        recordId: id
      }),
      [id]
    );
    const cache = useTaskWorkspaceRecordCache({
      api,
      authorityKey,
      enabled: true,
      freshnessKey,
      identity,
      onRecordReady,
      syntheticLoad: null
    });
    const run = {
      ...selected,
      item: {
        ...selected.item,
        run: { ...selected.item.run, record: { ...selected.item.run.record, recordId: id } }
      }
    };
    return (
      <TaskWorkspaceConversation
        {...conversationProps(run, null, {
          selectedRecord: cache.recordLoad.record,
          recordError: cache.recordLoad.error,
          liveStatus: cache.recordLoad.status === "loading" ? "loading" : "unavailable",
          getRunScrollTop: cache.getRunScrollTop,
          onRunScrollTopChange: cache.onRunScrollTopChange
        })}
        api={api}
        t={t}
      />
    );
  }
  return { Reader, api };
}

afterEach(cleanupRendererTestEnvironment);

describe("Task Workspace selected record background refresh", () => {
  it("keeps the CLI reading surface mounted through polling, terminal detail and a late report", async () => {
    const terminal = deferred<TaskWorkspaceRunDetail>();
    const report = deferred<TaskWorkspaceRunDetail>();
    const read = vi
      .fn<() => Promise<TaskWorkspaceRunDetail>>()
      .mockResolvedValueOnce(detail("# Existing output"))
      .mockImplementationOnce(() => terminal.promise)
      .mockImplementationOnce(() => report.promise);
    const { Reader, api } = harness(read);
    const view = render(<Reader freshnessKey="running" />);
    await screen.findByRole("heading", { name: "Existing output" });
    const viewport = screen.getByTestId("task-workspace-cli-run");
    viewport.scrollTop = 240;
    const stderr = screen.getByText("real stderr summary").closest("details")!;
    stderr.open = true;

    view.rerender(<Reader freshnessKey="terminal" />);
    expect(viewport.isConnected).toBe(true);
    expect(viewport.scrollTop).toBe(240);
    expect(stderr.open).toBe(true);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => {
      terminal.resolve({
        ...detail("# Terminal output"),
        record: { ...detail("# Terminal output").record, finishedAt: "2026-07-13T00:01:00.000Z" }
      });
      await terminal.promise;
    });
    expect(screen.getByRole("heading", { name: "Terminal output" })).toBeInTheDocument();
    view.rerender(<Reader freshnessKey="late-report" />);
    expect(viewport.isConnected).toBe(true);
    await act(async () => {
      report.resolve(detail("# Submitted report"));
      await report.promise;
    });
    expect(screen.getByRole("heading", { name: "Submitted report" })).toBeInTheDocument();
    expect(screen.getByTestId("task-workspace-cli-run")).toBe(viewport);
    expect(viewport.scrollTop).toBe(240);
    expect(stderr.open).toBe(true);
    expect(api.detectTerminalApps).toHaveBeenCalledOnce();
  });

  it.each([
    "record",
    "authority"
  ] as const)("clears old content immediately on %s switch and ignores its pending refresh", async (kind) => {
    const obsolete = deferred<TaskWorkspaceRunDetail>();
    const next = deferred<TaskWorkspaceRunDetail>();
    const read = vi
      .fn<() => Promise<TaskWorkspaceRunDetail>>()
      .mockResolvedValueOnce(detail("# Private prior output"))
      .mockImplementationOnce(() => obsolete.promise)
      .mockImplementationOnce(() => next.promise);
    const { Reader } = harness(read);
    const view = render(<Reader freshnessKey="initial" />);
    await screen.findByRole("heading", { name: "Private prior output" });
    view.rerender(<Reader freshnessKey="refresh" />);
    const id = kind === "record" ? "T-001#B-001::RUN-002" : recordId;
    view.rerender(
      <Reader
        freshnessKey="next"
        id={id}
        authorityKey={kind === "authority" ? "authority-b" : "authority-a"}
      />
    );
    expect(screen.queryByRole("heading", { name: "Private prior output" })).not.toBeInTheDocument();
    await act(async () => {
      obsolete.resolve(detail("# Obsolete response"));
      await obsolete.promise;
    });
    expect(screen.queryByRole("heading", { name: "Obsolete response" })).not.toBeInTheDocument();
    await act(async () => {
      next.resolve(detail("# New selection", id));
      await next.promise;
    });
    expect(screen.getByRole("heading", { name: "New selection" })).toBeInTheDocument();
  });

  it("preserves the readable result on refresh failure, surfaces the error, and recovers on the next refresh", async () => {
    const refresh = deferred<TaskWorkspaceRunDetail>();
    const read = vi
      .fn<() => Promise<TaskWorkspaceRunDetail>>()
      .mockResolvedValueOnce(detail("# Readable report"))
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce(detail("# Recovered report"));
    const { Reader } = harness(read);
    const view = render(<Reader freshnessKey="initial" />);
    await screen.findByRole("heading", { name: "Readable report" });
    const viewport = screen.getByTestId("task-workspace-cli-run");
    view.rerender(<Reader freshnessKey="failed" />);
    await act(async () => {
      refresh.reject(new Error("detail read failed"));
    });
    expect(screen.getByRole("heading", { name: "Readable report" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("detail read failed");
    view.rerender(<Reader freshnessKey="recovery" />);
    await screen.findByRole("heading", { name: "Recovered report" });
    expect(screen.getByTestId("task-workspace-cli-run")).toBe(viewport);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
