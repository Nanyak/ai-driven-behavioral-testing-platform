// F1 — Pass/fail trend + KPIs from GET /api/reports. Hand-rolled SVG only.
// Degrades to an empty state at zero runs (no NaN, no crash).
import { useMemo } from "react";
import { Activity } from "lucide-react";
import type { ReportRow } from "../reports/reports.js";
import { EmptyState } from "../ui/primitives.js";

function passRate(r: ReportRow): number {
  const denom = r.totals.passed + r.totals.failed;
  return denom === 0 ? 0 : r.totals.passed / denom;
}

export function TrendPanel({ reports }: { reports: ReportRow[] }) {
  // /api/reports is newest-first; chart oldest -> newest left to right.
  const series = useMemo(() => [...reports].reverse(), [reports]);

  const kpis = useMemo(() => {
    if (series.length === 0) {
      return { latest: null as ReportRow | null, rate: 0, runs: 0 };
    }
    const latest = series[series.length - 1];
    const agg = series.reduce(
      (acc, r) => {
        acc.passed += r.totals.passed;
        acc.failed += r.totals.failed;
        return acc;
      },
      { passed: 0, failed: 0 }
    );
    const denom = agg.passed + agg.failed;
    return {
      latest,
      rate: denom === 0 ? 0 : agg.passed / denom,
      runs: series.length,
    };
  }, [series]);

  if (series.length === 0) {
    return (
      <EmptyState icon={<Activity size={28} aria-hidden="true" />}>
        No runs archived yet. Run a suite in <strong>Test Runner</strong> and the pass/fail trend
        will appear here.
      </EmptyState>
    );
  }

  // SVG geometry
  const W = 480;
  const H = 96;
  const padX = 6;
  const n = series.length;
  const barGap = 3;
  const barW = n > 0 ? Math.max(2, (W - padX * 2 - barGap * (n - 1)) / n) : 0;

  // Sparkline of pass-rate (0..1) across runs.
  const linePts = series.map((r, i) => {
    const x = padX + i * (barW + barGap) + barW / 2;
    const y = H - 8 - passRate(r) * (H - 16);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const latest = kpis.latest!;
  const latestGreen = latest.status === "green";

  return (
    <div className="trend">
      <div className="trend-kpis">
        <div className="kpi">
          <span className="kpi-label">Latest run</span>
          <span className={`kpi-value ${latestGreen ? "ok" : "bad"}`}>
            {latest.status.toUpperCase()}
          </span>
          <span className="kpi-sub">
            {latest.totals.passed}/{latest.totals.passed + latest.totals.failed} passed
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Pass rate</span>
          <span className="kpi-value">{Math.round(kpis.rate * 100)}%</span>
          <span className="kpi-sub">across {kpis.runs} runs</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Runs</span>
          <span className="kpi-value">{kpis.runs}</span>
          <span className="kpi-sub">archived</span>
        </div>
      </div>

      <figure className="trend-chart">
        <figcaption className="trend-cap">
          Pass / fail by run (oldest → newest)
        </figcaption>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Pass/fail trend across ${n} runs. Latest run ${latest.status}.`}
          preserveAspectRatio="none"
          className="trend-svg"
        >
          {/* stacked pass/fail bars */}
          {series.map((r, i) => {
            const total = Math.max(1, r.totals.passed + r.totals.failed + r.totals.skipped);
            const x = padX + i * (barW + barGap);
            const usableH = H - 16;
            const passH = (r.totals.passed / total) * usableH;
            const failH = (r.totals.failed / total) * usableH;
            const skipH = (r.totals.skipped / total) * usableH;
            const base = H - 8;
            return (
              <g key={r.slug}>
                <rect
                  x={x}
                  y={base - skipH}
                  width={barW}
                  height={skipH}
                  className="bar-skip"
                />
                <rect
                  x={x}
                  y={base - skipH - failH}
                  width={barW}
                  height={failH}
                  className="bar-fail"
                />
                <rect
                  x={x}
                  y={base - skipH - failH - passH}
                  width={barW}
                  height={passH}
                  className="bar-pass"
                >
                  <title>
                    {r.run_id}: {r.totals.passed} passed, {r.totals.failed} failed,{" "}
                    {r.totals.skipped} skipped
                  </title>
                </rect>
              </g>
            );
          })}
          {/* pass-rate sparkline overlay */}
          {n > 1 ? (
            <polyline points={linePts.join(" ")} className="trend-line" fill="none" />
          ) : null}
          {linePts.map((p, i) => {
            const [cx, cy] = p.split(",");
            return <circle key={i} cx={cx} cy={cy} r={1.8} className="trend-dot" />;
          })}
        </svg>
        <div className="trend-legend" aria-hidden="true">
          <span className="lg lg-pass">passed</span>
          <span className="lg lg-fail">failed</span>
          <span className="lg lg-skip">skipped</span>
          <span className="lg lg-line">pass rate</span>
        </div>
      </figure>
    </div>
  );
}
