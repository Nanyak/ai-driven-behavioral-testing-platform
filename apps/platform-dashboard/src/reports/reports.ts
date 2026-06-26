// Client bindings for archived report history (reports/runs/).

export interface ReportRow {
  run_id: string;
  slug: string;
  generated_at: string | null;
  status: "green" | "red" | "invalid";
  totals: { executed: number; passed: number; failed: number; skipped: number };
}

export async function fetchReports(): Promise<ReportRow[]> {
  const response = await fetch("/api/reports");
  if (!response.ok) {
    throw new Error(`/api/reports returned ${response.status}`);
  }
  const body = (await response.json()) as { reports?: ReportRow[] };
  return body.reports ?? [];
}

export function reportViewUrl(slug: string): string {
  return `/api/reports/view?run=${encodeURIComponent(slug)}`;
}
