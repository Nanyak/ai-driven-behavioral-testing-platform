import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchTestRunStatus,
  startTestRun,
  type RunTarget,
  type TestRunStatus,
} from "./runner.js";

/**
 * Drives a test run: starts it, polls status while it's running, and calls `onFinished`
 * once when the run completes (so a caller can react — e.g. surface a "view report" prompt).
 */
export function useTestRun(onFinished?: () => void) {
  const [status, setStatus] = useState<TestRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const wasRunning = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const poll = useCallback(async () => {
    try {
      const next = await fetchTestRunStatus();
      setStatus(next);
      if (next.state === "running") {
        wasRunning.current = true;
        timer.current = window.setTimeout(() => void poll(), 1500);
      } else if (wasRunning.current) {
        wasRunning.current = false;
        onFinishedRef.current?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read run status");
    }
  }, []);

  // Reflect any run already in progress (e.g. started from another tab) on mount.
  useEffect(() => {
    void poll();
    return clearTimer;
  }, [poll]);

  const run = useCallback(
    async (target: RunTarget) => {
      setError(null);
      try {
        const next = await startTestRun(target);
        setStatus(next);
        wasRunning.current = true;
        clearTimer();
        timer.current = window.setTimeout(() => void poll(), 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start run");
      }
    },
    [poll]
  );

  return { status, error, run, isRunning: status?.state === "running" };
}
