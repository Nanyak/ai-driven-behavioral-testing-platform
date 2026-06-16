# Local Development

## System Under Test

Medusa is the selected backend system under test. The platform will generate traffic against Medusa Store and Admin REST APIs, ingest the resulting logs, model behavior flows, generate Playwright API tests, and report regressions.

## Requirements

Install these tools before starting Phase 1:

| Tool | Requirement | Purpose |
| --- | --- | --- |
| Node.js | 20 LTS or newer | Medusa, TypeScript services, Playwright tests |
| npm | 10 or newer | Node package manager |
| Docker Desktop or Docker Engine | Current stable version | Local infrastructure containers |
| Docker Compose | v2 or newer | Multi-service local environment |
| PostgreSQL | 15 or newer | Medusa database |
| Redis | 7 or newer | Optional Medusa caching/event support |

PostgreSQL, Redis, and the Medusa backend can be installed and run locally, or started together through Docker Compose for an easier development path.

Start the Compose stack from the repository root:

```bash
npm run compose:up
```

The Compose stack uses the root `.env`, mounts it over the container backend `.env`, initializes the Medusa database before the app starts, then exposes Medusa at `http://localhost:9000/app`, PostgreSQL at `localhost:5432`, and Redis at `localhost:6379`. Stop it with:

```bash
npm run compose:down
```

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
| Storefront | 8000 | Phase 3 customer storefront |
| Platform dashboard | 5173 | Phase 3 platform status dashboard |
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
npm run check:phase0
```

The command checks that the expected scaffold, documentation, environment template, and workspace files exist.

## Running lean & disk hygiene

The full Compose stack (`compose:up` + `elk:up`) starts ten containers — including
the storefront, dashboard, and Kibana, which are **not needed** for traffic
generation or the Phase 5/6 checks. Running everything at once is memory-heavy and
has wedged Docker Desktop on Windows. Prefer the slim set:

```bash
npm run stack:core      # postgres, redis, medusa, elasticsearch, logstash, filebeat (only)
# ... generate traffic, run checks ...
npm run stack:down      # stop & remove the containers when you're done
npm run stack:reset     # same, but also delete volumes (fresh DB + empty ES) — use to reclaim space
```

Always tear the stack down at the end of a session rather than leaving it idling.

### Avoiding the WSL2 / Docker disk-bloat trap

Docker Desktop's virtual disk grows with every `--build` and with Elasticsearch's
data volume. On **Windows/WSL2** that disk (`%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`)
**never returns freed space to the host** — it can fill `C:` and hang the daemon.
Prevent it:

1. **Cap the disk** — Docker Desktop → Settings → Resources → Advanced →
   *Virtual disk limit* → ~40–48 GB. Turns a machine-killer into a recoverable
   "no space" error.
2. **Prune regularly** — `npm run stack:reclaim` (build cache + dangling images),
   the usual silent hogs after repeated rebuilds.
3. **Run lean + tear down** — see `stack:core` / `stack:down` above.

To reclaim a disk that has already bloated, the reliable route is Docker Desktop →
**Troubleshoot → Clean / Purge data** (deletes and recreates the data disk). Note
that `docker system prune` and `diskpart compact vdisk` do **not** shrink the
`.vhdx` on their own, and `wsl --unregister docker-desktop` leaves the separate
`docker_data.vhdx` behind. Data here is reproducible (images re-pull, volumes
reseed via `medusa:setup` / a fresh traffic run), so purging is low-risk.

### Localhost vs IPv4 on Windows

Node `fetch` (and sometimes curl) may resolve `localhost` to IPv6 `::1` and fail
against a service that only binds IPv4, surfacing as an intermittent connection
error or a generator preflight that "can't reach Medusa". Force IPv4 when this
happens:

```bash
MEDUSA_BACKEND_URL=http://127.0.0.1:9000 npm run traffic:generate
ELASTICSEARCH_URL=http://127.0.0.1:9200 npm run ingest:run
```

### macOS

Docker Desktop on macOS keeps its data in a single `Docker.raw`
(`~/Library/Containers/com.docker.docker/Data/vms/0/`). It reclaims freed space far
better than WSL2, so the never-shrinks trap is unlikely — but the same habits
(disk-size cap, `stack:reclaim`, tear-down) still apply. The Troubleshoot →
Clean / Purge data button works the same cross-platform.
