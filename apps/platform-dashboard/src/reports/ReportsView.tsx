import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileJson, RefreshCw } from "lucide-react";
import { fetchReports, reportViewUrl, type ReportRow } from "./reports.js";
import { Badge, EmptyState, Skeleton } from "../ui/primitives.js";

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ReportsView() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  async function load() {
    setState("loading");
    setError(null);
    try {
      const rows = await fetchReports();
      setReports(rows);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
      setState("error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selectedRow = useMemo(
    () => reports.find((r) => r.slug === selected) ?? reports[0] ?? null,
    [reports, selected]
  );

  if (state === "loading") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton height={28} width={120} />
        <Skeleton height={64} />
        <Skeleton height={64} />
      </div>
    );
  }
  if (state === "error") {
    return (
      <EmptyState icon={<FileJson size={28} aria-hidden="true" />}>
        <p>Could not load reports: {error}</p>
        <button type="button" onClick={load}>
          Retry
        </button>
      </EmptyState>
    );
  }
  if (reports.length === 0) {
    return (
      <EmptyState icon={<FileJson size={28} aria-hidden="true" />}>
        No report runs yet. Head to the <strong>Test Runner</strong> tab and run a suite — each run
        is archived under <code>reports/runs/</code> and listed here.
      </EmptyState>
    );
  }

  return (
    <div className="reports">
      <div className="reports-toolbar">
        <span className="reports-count">{reports.length} runs</span>
        <button type="button" onClick={load} title="Reload reports">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="reports-layout">
        <ul className="reports-list">
          {reports.map((r) => (
            <li key={r.slug}>
              <button
                type="button"
                className={`report-row ${selectedRow?.slug === r.slug ? "selected" : ""}`}
                onClick={() => setSelected(r.slug)}
              >
                <span className="report-row-top">
                  <Badge tone={r.status === "green" ? "ok" : "bad"}>
                    {r.status.toUpperCase()}
                  </Badge>
                  <span className="report-run-id">{r.run_id}</span>
                </span>
                <span className="report-row-meta">
                  <span className="muted">{formatWhen(r.generated_at)}</span>
                  <span className="report-totals">
                    <span className="t-pass">{r.totals.passed} passed</span>
                    <span className="t-fail">{r.totals.failed} failed</span>
                    <span className="t-skip">{r.totals.skipped} skipped</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selectedRow ? (
          <div className="report-viewer">
            <div className="report-viewer-bar">
              <span className="muted">{selectedRow.run_id}</span>
              <a
                href={reportViewUrl(selectedRow.slug)}
                target="_blank"
                rel="noreferrer"
                className="report-open"
              >
                Open in new tab <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
            <iframe
              key={selectedRow.slug}
              title={`report ${selectedRow.run_id}`}
              src={reportViewUrl(selectedRow.slug)}
              className="report-frame"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
