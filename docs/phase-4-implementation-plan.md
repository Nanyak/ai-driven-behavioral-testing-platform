# Phase 4 Implementation Plan

## Goal

Wire up the ELK stack so that Medusa structured logs flow from the **Medusa container's stdout** into Elasticsearch and become searchable in Kibana. Collection is done by **Filebeat** (reading the Docker json-file logs), and **Logstash** parses and ships to Elasticsearch. This is a prerequisite for all downstream phases: data ingestion, behavioral modeling, and test generation.

> Collection note: an earlier iteration had Logstash read `logs/medusa-json.log` directly. That was replaced by Filebeat → Logstash because tailing a host-written bind-mounted file is unreliable on Docker Desktop for Windows (host writes don't propagate inotify events into the container). Reading the container's stdout (json-file logs, written inside the Docker VM) is robust and more production-realistic — apps log to stdout, a collector ships them. Medusa still also writes `logs/medusa-json.log` for local inspection, but it is no longer the ingestion source.

## Service URLs

| Service | Port | URL |
| --- | --- | --- |
| Elasticsearch | 9200 | `http://localhost:9200` |
| Kibana | 5601 | `http://localhost:5601` |
| Logstash | internal (beats 5044) | — |
| Filebeat | internal | — |

## Tech Stack

- **Elasticsearch 8.13.4** — single-node, security disabled for local development
- **Kibana 8.13.4** — log search and visualization
- **Logstash 8.13.4** — `beats` input, parses the JSON line, drops non-Medusa noise, ships to Elasticsearch
- **Filebeat 8.13.4** — collects the Medusa container's stdout (Docker json-file logs) and ships raw lines to Logstash on 5044

All four images use the same version (`8.13.4`) to avoid compatibility issues.

## Architecture

```text
Medusa container stdout  (Docker json-file logs: /var/lib/docker/containers/*/*.log)
        │
        ▼
   Filebeat (container input)  ──ships raw `message`──►  Logstash :5044 (beats input)
                                                              │  json filter: parse `message`
                                                              │  drop unless source == "medusa"
                                                              │  strip Filebeat/Beats metadata
                                                              ▼
                                                   Elasticsearch → index: behavior-logs-YYYY.MM.dd
                                                              │
                                                              ▼
                                                            Kibana
```

## Configuration Files

### `infra/elasticsearch/elasticsearch.yml`

```yaml
cluster.name: behavior-testing
node.name: node-01
network.host: 0.0.0.0
http.port: 9200
discovery.type: single-node
xpack.security.enabled: false
xpack.security.enrollment.enabled: false
```

### `infra/kibana/kibana.yml`

```yaml
server.host: "0.0.0.0"
server.name: kibana
elasticsearch.hosts: ["http://elasticsearch:9200"]
```

### `infra/logstash/logstash.yml`

```yaml
http.host: "0.0.0.0"
xpack.monitoring.enabled: false
```

### `infra/filebeat/filebeat.yml`

```yaml
filebeat.inputs:
  - type: container
    paths:
      - /var/lib/docker/containers/*/*.log

# Filebeat only ships the raw stdout line in `message`; Logstash decodes the
# JSON (separation of concerns).
output.logstash:
  hosts: ["logstash:5044"]

filebeat.registry.path: /usr/share/filebeat/data/registry
logging.level: info
```

### `infra/logstash/pipeline/medusa.conf`

```ruby
input {
  beats {
    port => 5044
    ecs_compatibility => "disabled"
  }
}

filter {
  json {
    source => "message"
    ecs_compatibility => "disabled"
  }

  # Drop everything that is not one of our structured Medusa logs.
  if [source] != "medusa" {
    drop {}
  }

  mutate {
    remove_field => ["@version", "message", "log", "host", "agent", "ecs", "input", "container", "stream", "tags"]
  }
}

output {
  elasticsearch {
    hosts => ["http://elasticsearch:9200"]
    index => "behavior-logs-%{+YYYY.MM.dd}"
  }
}
```

Key decisions:

- **Stdout collection, not file tailing.** Filebeat reads the Docker json-file logs written inside the VM, avoiding the Windows bind-mount inotify problem.
- **Filebeat ships, Logstash parses.** Filebeat stays minimal (raw `message`); Logstash owns the `json` parse, the noise drop, and metadata stripping — the canonical Beats → Logstash split.
- **`ecs_compatibility => "disabled"`** on both the `beats` input and the `json` filter. Without it, Logstash injects an ECS `[event][original]` object that collides with our semantic string `event` field (e.g. `"cart_item_added"`) and fails every line.
- **`if [source] != "medusa" { drop }`** filters Medusa framework noise and any other container's stdout — only our structured lines (which carry `"source":"medusa"`) are indexed.
- **Metadata stripping** keeps the ES document at the original flat top-level schema (`service`, `event`, `endpoint`, `status`, …) with no Filebeat/Beats leakage.
- Daily indices (`behavior-logs-YYYY.MM.dd`) match the `behavior-logs-*` wildcard pattern.

### Index template for bodies-on (`infra/elasticsearch/behavior-logs-template.json`)

Production logs are **bodies-off** by default, so `response_body`/`request_payload` are absent. When `LOG_CAPTURE_BODIES=true`, those fields become free-form JSON whose shape varies per endpoint and breaks dynamic mapping (HTTP 400). A composable template maps them as `flattened`. Apply it once with `npm run es:template` (it affects indices created afterwards).

## Docker Compose

The ELK services (Elasticsearch, Kibana, Logstash, Filebeat) live in the root `docker-compose.yml` under the `elk` profile, so they share the Docker network (Filebeat resolves `logstash`, Logstash resolves `elasticsearch`) while still letting you run Medusa alone.

Filebeat mounts:
- `./infra/filebeat/filebeat.yml:/usr/share/filebeat/filebeat.yml:ro`
- `/var/lib/docker/containers:/var/lib/docker/containers:ro` (the Docker json-file logs)
- a named `filebeat_registry` volume (so it does not re-ship lines after a restart)

It runs as `user: root` to read the container logs, with `command: filebeat -e --strict.perms=false`.

Memory limits:
- Elasticsearch: `ES_JAVA_OPTS=-Xms512m -Xmx512m`
- Logstash: `LS_JAVA_OPTS=-Xms256m -Xmx512m`

Logstash and Kibana start only after Elasticsearch reports healthy; Filebeat starts after Logstash.

## Root Scripts

```bash
npm run elk:up        # docker-compose --profile elk up -d (ES, Kibana, Logstash, Filebeat)
npm run elk:down      # docker-compose --profile elk down
npm run elk:logs      # docker-compose --profile elk logs -f logstash elasticsearch kibana
npm run es:template   # install the flattened-body index template (for bodies-on)
npm run check:phase4  # scripts/check-phase4.mjs
```

## Kibana Index Pattern Setup (one-time manual step)

After `npm run elk:up` and logs are indexed:

1. Open `http://localhost:5601`
2. Go to **Stack Management → Index Patterns** (or **Data Views** in newer Kibana)
3. Create index pattern `behavior-logs-*` with `@timestamp` as the time field
4. Go to **Discover** to search and filter logs

Useful filters:
- `user_role: "customer"`
- `service: "cart-service"`
- `event: "cart_item_added"`
- `status: 404`
- `endpoint: "/store/carts/{id}/line-items"`

> Note: logs intentionally carry no `persona` field. Persona is **not** logged or assigned at ingestion — it is derived later as an emergent flow attribute in Phase 7 (see plan §10.3 and the `persona-classification` memory). Filter and group by `user_role` (`customer`, `admin`, or `null` for unauthenticated guests) instead; `user_role` is the JWT-derived signal and is also the held-out ground truth used to validate emergent classification.

## Elasticsearch Index Fields

The `behavior-logs-*` index is populated from Medusa's **production-shaped hybrid** logs. Key fields:

| Field | Type | Description |
| --- | --- | --- |
| `@timestamp` | date | Log event time (from Logstash) |
| `timestamp` | date | Request timestamp from Medusa middleware |
| `level` | keyword | `INFO` / `WARN` / `ERROR` (derived from status) |
| `service` | keyword | Logical bounded-context derived from the route (`cart-service`, `product-catalog`, `admin-service`, …) |
| `environment` | keyword | Deployment tag (`production`) |
| `request_id` | keyword | Per-request identifier |
| `trace_id` | keyword | Per-request trace identifier |
| `session_id` | keyword | Per-session identifier |
| `user_role` | keyword | JWT-derived role (`customer`, `admin`, or `null` for guests); persona is **not** logged — derived in Phase 7 |
| `user_id` | keyword | Customer or admin ID when authenticated |
| `event` | keyword | Semantic business event (`cart_item_added`, `checkout_completed`, …) |
| `method` | keyword | HTTP method |
| `endpoint` | keyword | Normalized route with `{id}` placeholders (`/store/carts/{id}/line-items`) |
| `status` | integer | HTTP response status code |
| `duration_ms` | float | Request duration in milliseconds |
| `source` | keyword | Always `medusa` |
| `request_payload` / `response_body` | flattened | Present only when `LOG_CAPTURE_BODIES=true` |

## Verification

```bash
# 1. Start Medusa (emits production-shaped logs to stdout)
npm run compose:up

# 2. Start ELK (Elasticsearch, Kibana, Logstash, Filebeat)
npm run elk:up

# 3. Generate traffic so there is something to index (Phase 5)
npm run traffic:generate

# 4. Verify ELK, then the traffic mix
npm run check:phase4
npm run check:phase5
```

Expected output:

```
Phase 4: ELK Integration Check
  Elasticsearch: http://localhost:9200
  Kibana:        http://localhost:5601

[1] Elasticsearch
  ✓ Elasticsearch reachable
  ✓ Cluster health: green

[2] Kibana
  ✓ Kibana reachable

[3] behavior-logs-* index
  ✓ Index exists: behavior-logs-2026.06.13

[4] Document count
  ✓ 1301 document(s) indexed

[5] Field filters
  ✓ Filter by session_id works (1289 docs, sample: "sess-customer-...")
  ✓ Filter by user_role works (328 docs, sample: "customer")
  ✓ Filter by status (response code) works (1301 docs, sample: 200)

8 checks — 8 passed, 0 failed
```

> Note: `green`/`yellow` cluster status is both fine for a single-node Elasticsearch instance — a `yellow` status only means one replica shard is unassigned because there is no second node. All data is readable and writable normally.
