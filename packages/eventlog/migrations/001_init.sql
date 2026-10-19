create table runs   (run_id uuid primary key, flow_id text not null, flow_name text not null,
                     status text not null, created_at timestamptz not null, updated_at timestamptz not null,
                     last_seq bigint not null);
create index runs_status_created on runs (status, created_at desc);
create table events (run_id uuid not null references runs, seq bigint not null, ts timestamptz not null,
                     type text not null, payload jsonb not null, primary key (run_id, seq));
