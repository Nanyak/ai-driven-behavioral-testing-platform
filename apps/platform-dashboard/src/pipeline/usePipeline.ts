import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchJobStatus,
  startJob,
  type JobParams,
  type JobStatus,
  type PipelineJob,
} from "./pipeline.js";

/**
 * Drives the single-flight pipeline job: starts it, polls status while it's running,
 * and calls `onFinished` once when it completes (so the caller can refresh the flow
 * list / summary so newly mined candidates and generated specs appear). Mirrors
 * `runner/useTestRun.ts`; both poll the same server lock, so this also reflects a
 * suite run started from the Test Runner as `isRunning`.
 */
export function usePipeline(onFinished?: (status: JobStatus) => void) {
  const [status, setStatus] = useState<JobStatus | null>(null);
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
      const next = await fetchJobStatus();
      setStatus(next);
      if (next.state === "running") {
        wasRunning.current = true;
        timer.current = window.setTimeout(() => void poll(), 1500);
      } else if (wasRunning.current) {
        wasRunning.current = false;
        onFinishedRef.current?.(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read job status");
    }
  }, []);

  // Reflect any job already in progress (e.g. started from another tab/view) on mount.
  useEffect(() => {
    void poll();
    return clearTimer;
  }, [poll]);

  const run = useCallback(
    async (job: PipelineJob, params?: JobParams) => {
      setError(null);
      try {
        const next = await startJob(job, params);
        setStatus(next);
        wasRunning.current = true;
        clearTimer();
        timer.current = window.setTimeout(() => void poll(), 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start job");
      }
    },
    [poll]
  );

  return { status, error, run, isRunning: status?.state === "running" };
}
