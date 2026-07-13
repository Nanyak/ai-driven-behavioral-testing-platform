import { normalizeEndpoint } from "../../../log-ingestion/src/pipeline.js";

export function requestEndpoint(method: string | undefined, url: string | undefined): string {
  return `${(method ?? "GET").toUpperCase()} ${normalizeEndpoint(url ?? "/")}`;
}
