create table if not exists invariants (
  id             text primary key,
  flow_signature text not null,
  flow_name      text,
  cache_key      text,
  step_title     text not null,
  source         text not null,
  polarity       text,
  kind           text,
  verified       boolean not null default false,
  payload        jsonb not null,
  proposed_at    timestamptz,
  verified_at    timestamptz
);

create index if not exists invariants_flow_idx on invariants (flow_signature);
create index if not exists invariants_verified_idx
  on invariants (flow_signature, step_title)
  where verified = true;
