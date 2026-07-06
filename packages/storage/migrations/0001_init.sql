create table if not exists storage_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists decisions (
  review_id        text primary key,
  flow_signature   text not null,
  status           text not null check (status in ('approved', 'discarded', 'superseded')),
  status_signature text,
  route_key        text,
  test_path        text,
  spec_hash        text,
  body_plan_hash   text,
  decided_by       text,
  decided_at       timestamptz not null default now(),
  superseded_by    text,
  retired_at       timestamptz,
  payload          jsonb not null
);
create index if not exists decisions_flow_signature_idx on decisions (flow_signature);
create index if not exists decisions_active_idx on decisions (retired_at) where retired_at is null;

create table if not exists dismissed_relationships (
  pair_key text primary key,
  payload  jsonb not null
);

create table if not exists run_index (
  slug         text primary key,
  generated_at timestamptz,
  status       text check (status is null or status in ('green', 'red', 'invalid')),
  totals       jsonb,
  payload      jsonb not null
);

create table if not exists manifest (
  review_id text primary key,
  payload   jsonb not null
);

create table if not exists storage_metadata (
  key     text primary key,
  payload jsonb not null
);
