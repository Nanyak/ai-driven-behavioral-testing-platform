import { useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  FileCode2,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useFlows } from "./useFlows.js";
import type { Decision, ReviewFlow } from "./decisions.js";

const PERSONA_LABELS: Record<string, string> = {
  guest_shopper: "Guest Shopper",
  registered_customer: "Registered Customer",
  admin_operator: "Admin Operator",
};

type PersonaFilter = "all" | "guest_shopper" | "registered_customer" | "admin_operator";

function personaLabel(persona: string): string {
  return PERSONA_LABELS[persona] ?? persona;
}

function DecisionBadge({ flow }: { flow: ReviewFlow }) {
  if (flow.decision === "approved") {
    return (
      <span className="decision-badge approved">
        <CheckCircle2 size={14} aria-hidden="true" /> approved
      </span>
    );
  }
  if (flow.decision === "discarded") {
    return (
      <span className="decision-badge discarded">
        <XCircle size={14} aria-hidden="true" /> discarded
      </span>
    );
  }
  return (
    <span className="decision-badge none">
      <CircleDashed size={14} aria-hidden="true" /> undecided
    </span>
  );
}

function DetailPanel({
  flow,
  onDecide,
  pending,
}: {
  flow: ReviewFlow;
  onDecide: (status: Decision) => void;
  pending: boolean;
}) {
  return (
    <aside className="review-detail">
      <header>
        <h2>{flow.flow_name}</h2>
        <DecisionBadge flow={flow} />
      </header>
      <p className="review-detail-meta">
        <span>{personaLabel(flow.persona)}</span>
        <span>priority {flow.priority}</span>
        <span>support {flow.support}</span>
        <span>score {flow.score.toFixed(3)}</span>
        {flow.attributes.has_errors ? (
          <span className="error-flag">
            <ShieldAlert size={13} aria-hidden="true" /> has_errors
          </span>
        ) : null}
      </p>

      <section>
        <h3>Steps ({flow.step_count})</h3>
        <ol className="review-steps">
          {flow.steps.map((step, index) => (
            <li key={`${step.method}-${step.endpoint}-${index}`}>
              <code>{step.method}</code> {step.endpoint}
              <span className="step-status">→ {step.expected_status}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3>Golden assertions ({flow.assertion_fields.length})</h3>
        {flow.assertion_fields.length === 0 ? (
          <p className="muted">No field-level assertions recommended.</p>
        ) : (
          <ul className="review-assertions">
            {flow.assertion_fields.map((field) => (
              <li key={field}>
                <code>{field}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Provenance</h3>
        <p className="review-detail-meta">
          <span>{flow.source_sessions.length} source sessions</span>
          {flow.test_path ? (
            <span className="test-path">
              <FileCode2 size={13} aria-hidden="true" /> {flow.test_path}
            </span>
          ) : (
            <span className="muted">no generated test</span>
          )}
        </p>
        <code className="signature">{flow.signature}</code>
      </section>

      <footer className="review-actions">
        <button
          type="button"
          className="approve"
          disabled={pending}
          onClick={() => onDecide("approved")}
        >
          <CheckCircle2 size={16} aria-hidden="true" /> Approve
        </button>
        <button
          type="button"
          className="discard"
          disabled={pending}
          onClick={() => onDecide("discarded")}
        >
          <XCircle size={16} aria-hidden="true" /> Discard
        </button>
      </footer>
      <p className="review-note">
        Decisions persist to <code>data/hitl/approvals.json</code> and feed the Phase 7 skip
        gate — discarded flows do not re-surface on the next <code>behavior:mine</code>.
      </p>
    </aside>
  );
}

export function ReviewView() {
  const { data, state, error, reload, decide } = useFlows();
  const [persona, setPersona] = useState<PersonaFilter>("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const flows = data?.flows ?? [];

  const visible = useMemo(
    () =>
      flows.filter((flow) => {
        if (persona !== "all" && flow.persona !== persona) {
          return false;
        }
        if (errorsOnly && !flow.attributes.has_errors) {
          return false;
        }
        return true;
      }),
    [flows, persona, errorsOnly]
  );

  const selectedFlow =
    visible.find((flow) => flow.signature === selected) ?? visible[0] ?? null;

  async function handleDecide(signature: string, testPath: string | null, status: Decision) {
    setPending(true);
    setActionError(null);
    try {
      await decide(signature, status, testPath);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save decision");
    } finally {
      setPending(false);
    }
  }

  if (state === "loading" && !data) {
    return <p className="review-empty">Loading discovered flows…</p>;
  }

  if (state === "error") {
    return (
      <div className="review-empty">
        <p>Could not load flows: {error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <p className="review-empty">
        No discovered flows yet. Run <code>npm run behavior:mine</code> to produce test
        candidates, then refresh.
      </p>
    );
  }

  const personaOptions: PersonaFilter[] = [
    "all",
    "guest_shopper",
    "registered_customer",
    "admin_operator",
  ];

  return (
    <div className="review">
      <div className="review-toolbar">
        <div className="persona-filter" role="group" aria-label="Filter by persona">
          {personaOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={persona === option ? "active" : ""}
              onClick={() => setPersona(option)}
            >
              {option === "all" ? "All personas" : personaLabel(option)}
            </button>
          ))}
        </div>
        <label className="errors-toggle">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          has_errors only
        </label>
        <div className="review-counts">
          {data ? (
            <span>
              {data.counts.approved} approved · {data.counts.discarded} discarded ·{" "}
              {data.counts.undecided} undecided · {data.counts.covered}/{data.counts.total}{" "}
              covered (skipped next run)
            </span>
          ) : null}
          <button type="button" onClick={reload} title="Reload flows">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {actionError ? <p className="review-action-error">{actionError}</p> : null}

      <div className="review-layout">
        <ul className="review-list">
          {visible.map((flow) => (
            <li key={flow.signature}>
              <button
                type="button"
                className={`review-row ${selectedFlow?.signature === flow.signature ? "selected" : ""}`}
                onClick={() => setSelected(flow.signature)}
              >
                <span className="review-row-name">{flow.flow_name}</span>
                <span className="review-row-meta">
                  <span className={`persona-tag ${flow.persona}`}>
                    {personaLabel(flow.persona)}
                  </span>
                  <span className="muted">support {flow.support}</span>
                  <span className="muted">{flow.step_count} steps</span>
                  <span className="muted">{flow.assertion_fields.length} assertions</span>
                  {flow.test_path ? (
                    <span className="muted">
                      <FileCode2 size={12} aria-hidden="true" /> test
                    </span>
                  ) : null}
                  {flow.attributes.has_errors ? (
                    <span className="error-flag">
                      <ShieldAlert size={12} aria-hidden="true" /> errors
                    </span>
                  ) : null}
                  <DecisionBadge flow={flow} />
                </span>
              </button>
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="muted review-list-empty">No flows match this filter.</li>
          ) : null}
        </ul>

        {selectedFlow ? (
          <DetailPanel
            flow={selectedFlow}
            pending={pending}
            onDecide={(status) =>
              handleDecide(selectedFlow.signature, selectedFlow.test_path, status)
            }
          />
        ) : null}
      </div>
    </div>
  );
}
