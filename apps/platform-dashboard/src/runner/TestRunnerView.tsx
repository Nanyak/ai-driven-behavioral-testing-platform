import { useState } from "react";
import { ArrowRight, Loader2, Play } from "lucide-react";
import { RUN_TARGETS, type RunTarget } from "./runner.js";
import { useTestRun } from "./useTestRun.js";

const TARGET_HINTS: Record<RunTarget, string> = {
  all: "Every persona and path (npm run test:all)",
  guest: "Guest shopper specs only",
  customer: "Registered customer specs only",
  admin: "Admin operator specs only",
  happy: "Happy-path specs across personas",
  failure: "Failure-path specs across personas",
};

export function TestRunnerView({ onViewReports }: { onViewReports: () => void }) {
  const { status, error, run, isRunning } = useTestRun();
  const [target, setTarget] = useState<RunTarget>("all");

  const result =
    status && (status.state === "passed" || status.state === "failed") ? status : null;

  return (
    <div className="runner">
      <div className="run-panel">
        <div className="run-controls">
          <label className="run-target">
            Suite
            <select
              value={target}
              disabled={isRunning}
              onChange={(e) => setTarget(e.target.value as RunTarget)}
              title={TARGET_HINTS[target]}
            >
              {RUN_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="run-button"
            disabled={isRunning}
            onClick={() => void run(target)}
          >
            {isRunning ? (
              <>
                <Loader2 size={15} className="spin" aria-hidden="true" /> Running {status?.target}…
              </>
            ) : (
              <>
                <Play size={15} aria-hidden="true" /> Run tests
              </>
            )}
          </button>
          {result ? (
            <span className={`run-result ${result.state}`}>
              {result.state === "passed" ? "Passed" : `Failed (exit ${result.exit_code})`}
            </span>
          ) : null}
          {result ? (
            <button type="button" className="run-view-report" onClick={onViewReports}>
              View report <ArrowRight size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <p className="muted run-hint">
          Runs <code>npm run test:&lt;suite&gt;</code> against the live SUT. The archived run shows
          up under the <strong>Reports</strong> tab when it finishes.
        </p>

        {error ? <p className="review-action-error">{error}</p> : null}

        {status && status.output ? (
          <pre className="run-output" aria-label="test run output">
            {status.output.slice(-8000)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
