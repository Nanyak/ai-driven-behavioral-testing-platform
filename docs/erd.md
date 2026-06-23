# Entity / data-flow diagram

The platform's "entities" are the durable artifacts passed between stages (each a
JSON file on disk), plus the records inside them. This ER diagram shows their
fields and relationships; the prose data contracts are in
[`architecture.md`](./architecture.md) and the run order in
[`pipeline.md`](./pipeline.md).

## Entity relationships

```mermaid
erDiagram
    LOG_LINE ||--o{ SESSION_FLOW : "reconstructed into"
    SESSION_FLOW ||--|{ FLOW_STEP : contains
    SESSION_FLOW ||--o{ GOLDEN_CANDIDATE : "yields (observed bodies)"
    SESSION_FLOW }o--o{ TEST_CANDIDATE : "mined into"
    TEST_CANDIDATE ||--|{ MINED_STEP : "ordered sequence of"
    TEST_CANDIDATE ||--|| PERSONA : "classified as"
    TEST_CANDIDATE ||--o{ GENERATED_SPEC : "generated into"
    OPENAPI_SPEC ||--o{ GOLDEN_SCHEMA : "resolves"
    GOLDEN_CANDIDATE ||--o{ GOLDEN_SCHEMA : "tightens"
    GENERATED_SPEC ||--|{ RUN_RESULT : produces
    GOLDEN_SCHEMA ||--o{ RUN_RESULT : "asserted against"
    RUN_RESULT }|--|| REGRESSION_REPORT : "aggregated into"
    SESSION_FLOW ||--o{ CLASSIFICATION_REPORT : "validated by (holdout)"

    LOG_LINE {
        string method
        string endpoint
        int status
        string trace_id
        string timestamp
        json request_payload
        bool bodies_off "response bodies off by default"
    }

    SESSION_FLOW {
        string session_id PK
        string started_at
        string ended_at
        string[] role_observed "VALIDATION-ONLY (held-out JWT ground truth)"
    }

    FLOW_STEP {
        string method
        string endpoint
        string event
        int status
        string trace_id
        string timestamp
        json request_payload
        bool has_error
    }

    GOLDEN_CANDIDATE {
        string endpoint
        int status
        json observed_schema "shape/type, ignore-fields stripped"
    }

    OPENAPI_SPEC {
        string source "augmented Store/Admin OAS"
        string operation
        int status
    }

    GOLDEN_SCHEMA {
        string endpoint
        int status
        string schema_source "spec | observed"
        json schema "spec, tightened by observed"
    }

    TEST_CANDIDATE {
        string flow_id PK
        string name "LLM-named"
        int support "PrefixSpan distinct-session count"
        string persona_source "emergent_attributes"
        json suggested_assertions "LLM-recommended"
        json anomaly_flags "LLM-flagged"
    }

    MINED_STEP {
        int order
        string method
        string endpoint
    }

    PERSONA {
        string persona "guest_shopper | registered_customer | admin_operator"
        bool has_errors "orthogonal edge overlay"
    }

    GENERATED_SPEC {
        string path "generated-tests/<persona>/*.spec.ts"
        string persona
    }

    RUN_RESULT {
        string spec
        string persona
        string flow_id
        string endpoint
        string outcome "pass | fail"
    }

    REGRESSION_REPORT {
        string run_id PK
        int passed
        int failed
        json attribution "persona / flow / endpoint"
    }

    CLASSIFICATION_REPORT {
        string run_id PK
        json per_persona_precision_recall
        json confusion_matrix
        int holdout_support "register->login->checkout, accept >= 6"
        bool negative_control_pass
    }
```

## Reading the diagram

- **`LOG_LINE` → `SESSION_FLOW`**: log-ingestion reconstructs per-session journeys
  from Elasticsearch by `trace_id` / session correlation.
- **`SESSION_FLOW` → `TEST_CANDIDATE`**: the behavior engine mines frequent
  subsequences (PrefixSpan, n-gram, Markov) across many sessions into ranked,
  deduplicated candidates — a many-to-many relationship (one session contributes to
  several candidates; one candidate is supported by many sessions).
- **`role_observed` is validation-only**: it is the held-out JWT ground truth.
  Mining and classification never read it; only `CLASSIFICATION_REPORT` does, and
  only *after* classification — the guardrail behind the measured persona accuracy.
- **`OPENAPI_SPEC` + `GOLDEN_CANDIDATE` → `GOLDEN_SCHEMA`**: the spec is
  authoritative on field existence; observed bodies only *tighten* under-specified
  spec leaves (ADR 0001 / ADR 0004). This is the assertion oracle.
- **`GENERATED_SPEC` + `GOLDEN_SCHEMA` → `RUN_RESULT` → `REGRESSION_REPORT`**: the
  runner executes each generated spec against Medusa and compares the response to
  its golden schema, aggregating into the red/green report with attribution.
