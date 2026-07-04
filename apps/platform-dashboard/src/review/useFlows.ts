import { useCallback, useEffect, useState } from "react";
import {
  deleteDecision,
  deleteTest,
  fetchFlows,
  postDecision,
  type Decision,
  type FlowsPayload,
  type ReviewFlow,
} from "./decisions.js";

type LoadState = "loading" | "ready" | "error";

export function useFlows() {
  const [data, setData] = useState<FlowsPayload | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      setData(await fetchFlows());
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flows");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const decide = useCallback(
    async (
      flow: ReviewFlow,
      status: Decision,
      options?: { supersedeReviewId?: string; distinctFromReviewId?: string }
    ) => {
      await postDecision(flow, status, options);
      await reload();
    },
    [reload]
  );

  const removeTest = useCallback(
    async (flow: ReviewFlow) => {
      await deleteTest(flow);
      await reload();
    },
    [reload]
  );

  const removeDecision = useCallback(
    async (reviewId: string) => {
      await deleteDecision(reviewId);
      await reload();
    },
    [reload]
  );

  return { data, state, error, reload, decide, removeTest, removeDecision };
}
