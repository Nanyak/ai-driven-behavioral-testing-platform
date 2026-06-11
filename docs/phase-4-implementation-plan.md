# Phase 4 Implementation Plan

## Goal

Wire up the ELK stack so that Medusa structured logs flow from `logs/medusa-json.log` into Elasticsearch and become searchable in Kibana. This is a prerequisite for all downstream phases: data ingestion, behavioral modeling, and test generation.

## Service URLs

| Service | Port | URL |
| --- | --- | --- |
| Elasticsearch | 9200 | `http://localhost:9200` |
| Kibana | 5601 | `http://localhost:5601` |
| Logstash | internal | — |

## Tech Stack

- **Elasticsearch 8.13.4** — single-node, security disabled for local development
- **Kibana 8.13.4** — log search and visualization
- **Logstash 8.13.4** — reads Medusa NDJSON log file, parses JSON, ships to Elasticsearch

All three images use the same version (`8.13.4`) to avoid compatibility issues.

## Architecture

```text
logs/medusa-json.log
        │
        ▼
   Logstash (file input, json codec)
        │  filter: strip internal metadata
        ▼
   Elasticsearch  →  index: behavior-logs-YYYY.MM.dd
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

### `infra/logstash/pipeline/medusa.conf`

```ruby
input {
  file {
    path => "/workspace/logs/medusa-json.log"
    start_position => "beginning"
    sincedb_path => "/dev/null"
    codec => "json"
    tags => ["medusa"]
  }
}

filter {
  mutate {
    remove_field => ["@version", "host", "log", "event", "message"]
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

- `codec => "json"` parses each NDJSON line at input time — no separate `json` filter needed.
- `sincedb_path => "/dev/null"` makes Logstash re-read the full log file on every restart, which is useful for development and replay scenarios.
- `remove_field` strips internal Logstash metadata (`@version`, `host`, `log`, `event`, `message`) to keep documents clean for behavioral queries.
- Daily indices (`behavior-logs-YYYY.MM.dd`) match the `behavior-logs-*` wildcard pattern.

## Docker Compose

The ELK services live in the root `docker-compose.yml` under the `elk` profile. This keeps all services on the same Docker network (so Logstash can resolve `elasticsearch` by name) while still letting you run Medusa alone without starting Elasticsearch.

Memory limits:
- Elasticsearch: `ES_JAVA_OPTS=-Xms512m -Xmx512m`
- Logstash: `LS_JAVA_OPTS=-Xms256m -Xmx512m`

Logstash starts only after Elasticsearch reports healthy. Kibana starts only after Elasticsearch reports healthy.

The Logstash log volume mount is `./logs:/workspace/logs:ro` — the same `logs/` directory that Medusa writes to, so no separate file copy is needed.

## Root Scripts

```bash
npm run elk:up        # docker-compose --profile elk up -d
npm run elk:down      # docker-compose --profile elk down
npm run elk:logs      # docker-compose --profile elk logs -f logstash elasticsearch kibana
npm run check:phase4  # scripts/check-phase4.mjs
```

## Kibana Index Pattern Setup (one-time manual step)

After `npm run elk:up` and logs are indexed:

1. Open `http://localhost:5601`
2. Go to **Stack Management → Index Patterns** (or **Data Views** in newer Kibana)
3. Create index pattern `behavior-logs-*` with `@timestamp` as the time field
4. Go to **Discover** to search and filter logs

Useful filters:
- `persona: "guest_shopper"`
- `session_id: "session-abc"`
- `response_code: 404`
- `normalized_endpoint: "/store/carts/{id}/line-items"`

## Elasticsearch Index Fields

The `behavior-logs-*` index is populated from Medusa structured logs. Key fields:

| Field | Type | Description |
| --- | --- | --- |
| `@timestamp` | date | Log event time (from Logstash) |
| `timestamp` | date | Request timestamp from Medusa middleware |
| `trace_id` | keyword | Per-request trace identifier |
| `session_id` | keyword | Per-session identifier |
| `persona` | keyword | Traffic persona (`guest_shopper`, `registered_customer`, `admin_operator`, `edge_case`) |
| `role` | keyword | User role (`guest`, `customer`, `admin`) |
| `method` | keyword | HTTP method |
| `endpoint` | keyword | Raw request path |
| `normalized_endpoint` | keyword | Path with dynamic segments replaced (`/store/carts/{id}`) |
| `response_code` | integer | HTTP response status code |
| `duration_ms` | integer | Request duration in milliseconds |
| `user_id` | keyword | Customer or admin ID when authenticated |
| `source` | keyword | Always `medusa` |

## Verification

```bash
# 1. Start Medusa and generate some logs
npm run compose:up
# Browse the storefront or call a few APIs to produce log lines

# 2. Start ELK
npm run elk:up

# 3. Wait ~60 seconds for Elasticsearch to initialize, then run checks
npm run check:phase4
```

Expected output:

```
Phase 4: ELK Integration Check
  Elasticsearch: http://localhost:9200
  Kibana:        http://localhost:5601

[1] Elasticsearch
  ✓ Elasticsearch reachable
  ✓ Cluster health: yellow

[2] Kibana
  ✓ Kibana reachable

[3] behavior-logs-* index
  ✓ Index exists: behavior-logs-2026.06.11

[4] Document count
  ✓ 3031 document(s) indexed

[5] Field filters
  ✓ Filter by session_id works (1377 docs, sample: "dashboard-status-session")
  ✓ Filter by persona works (1377 docs, sample: "admin_operator")
  ✓ Filter by response_code works (3012 docs, sample: 200)

8 checks — 8 passed, 0 failed
```

> Note: `yellow` cluster status is expected for a single-node Elasticsearch instance — one replica shard remains unassigned because there is no second node to host it. All data is readable and writable normally.
