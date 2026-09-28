import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";

/** Consumes existing content notifications; it does not install additional canvas watchers. */
export function useSearchInvalidation({
  enabled,
  projectRoot,
  canvasFilterId,
  packageFingerprint
}: {
  enabled: boolean;
  projectRoot: string | null;
  canvasFilterId: string | undefined;
  packageFingerprint: string | undefined;
}) {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = enabled && visible;
  const invalidate = useCallback(() => {
    if (!active) return;
    setPending(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setRevision((value) => value + 1);
      setPending(false);
    }, 100);
  }, [active]);

  const previousContent = useRef({ projectRoot, packageFingerprint });
  useEffect(() => {
    const previous = previousContent.current;
    previousContent.current = { projectRoot, packageFingerprint };
    if (
      previous.projectRoot === projectRoot &&
      previous.packageFingerprint !== packageFingerprint
    ) {
      invalidate();
    }
  }, [invalidate, packageFingerprint, projectRoot]);

  useEffect(() => {
    if (!bridge || !projectRoot) return;
    const matches = (event: { projectRoot: string; canvasId?: string | null }) =>
      event.projectRoot === projectRoot && (!canvasFilterId || event.canvasId === canvasFilterId);
    const unsubscribePackage = bridge.onPackageFileChanged((event) => {
      if (matches(event)) invalidate();
    });
    const unsubscribeRuntime = bridge.onRuntimeStateChanged((event) => {
      if (matches(event)) invalidate();
    });
    return () => {
      unsubscribePackage();
      unsubscribeRuntime();
    };
  }, [canvasFilterId, invalidate, projectRoot]);

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  useEffect(() => {
    if (!active) setPending(false);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [active]);
  return { active: active && !pending, revision };
}
