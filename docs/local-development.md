# Local Development

## System Under Test

Medusa is the selected backend system under test. The platform will generate traffic against Medusa Store and Admin REST APIs, ingest the resulting logs, model behavior flows, generate Playwright API tests, and report regressions.

## Requirements

Install these tools before starting Phase 1:

| Tool | Requirement | Purpose |
| --- | --- | --- |
| Node.js | 20 LTS or newer | Medusa, TypeScript services, Playwright tests |
| pnpm | 9 or newer | Workspace package manager |
| Docker Desktop or Docker Engine | Current stable version | Local infrastructure containers |
| Docker Compose | v2 or newer | Multi-service local environment |
| PostgreSQL | 15 or newer | Medusa database |
| Redis | 7 or newer | Optional Medusa caching/event support |

PostgreSQL and Redis can be installed locally or run through Docker Compose once infrastructure is added.

## Implementation Language Decision

The MVP platform services will be written in TypeScript:

- `services/traffic-generator`
- `services/log-ingestion`
- `services/behavior-engine`
- `services/script-generator`
- `services/test-runner`

This keeps the platform aligned with Medusa and Playwright, reduces runtime setup, and allows shared TypeScript models across services.

Python is reserved for optional future analysis work, such as advanced sequence mining, ML experiments, or notebooks. It is not required for the Phase 0 or MVP service baseline.

## Expected Local Ports

| Service | Port | Notes |
| --- | --- | --- |
| Medusa backend | 9000 | Store API, Admin API, and Medusa admin app when available |
| PostgreSQL | 5432 | Medusa database |
| Redis | 6379 | Optional Medusa dependency |
| Elasticsearch | 9200 | Local single-node Elasticsearch HTTP API |
| Kibana | 5601 | Local Kibana UI |
| Logstash Beats input | 5044 | Used if Filebeat sends logs to Logstash |
| Logstash HTTP input | 8080 | Optional local HTTP log ingestion endpoint |

CLI-only services do not reserve inbound ports by default:

- Traffic generator
- Log ingestion service
- Behavior engine
- Script generator
- Test runner

## Workspace Layout

```text
apps/
  medusa/
infra/
  elasticsearch/
  logstash/
  kibana/
services/
  traffic-generator/
  log-ingestion/
  behavior-engine/
  script-generator/
  test-runner/
generated-tests/
golden-responses/
reports/
docs/
scripts/
```

## Verification

Run Phase 0 verification from the repository root:

```bash
pnpm check:phase0
```

The command checks that the expected scaffold, documentation, environment template, and workspace files exist.
