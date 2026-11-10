-- D1 bills per row read/written. Every query in src/ hits a primary key or one of
-- the indexes below (no full scans). Each index also costs a row write per insert,
-- so only indexes a query uses exist. See the query→index map in docs/DESIGN.md §5.

-- What the game was each day (ET date). raw_json is the exact /api/today payload.
CREATE TABLE games (
  day         TEXT PRIMARY KEY,
  day_number  INTEGER NOT NULL UNIQUE,
  resets_at   TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete')),
  raw_json    TEXT NOT NULL
);

-- The 7 prompts ("categories") of a day.
CREATE TABLE prompts (
  day        TEXT NOT NULL REFERENCES games(day),
  prompt_id  TEXT NOT NULL,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (day, prompt_id)
);

-- Mirror of the KV roster, keeping history of models that left it.
CREATE TABLE models (
  model_id     TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  first_seen   TEXT NOT NULL,
  last_config  TEXT NOT NULL
);

CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,
  batch              TEXT NOT NULL,               -- coordinator name: the day for real runs, 'day#trial-…' for tests
  day                TEXT NOT NULL REFERENCES games(day),
  model_id           TEXT NOT NULL REFERENCES models(model_id),
  attempt            INTEGER NOT NULL DEFAULT 1,
  trial              INTEGER NOT NULL DEFAULT 0,  -- 1 = manual test run, never counted
  status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'timed_out', 'failed', 'infra_error', 'aborted')),
  error              TEXT,
  prompt_version     TEXT NOT NULL,
  model_config       TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  total_score        INTEGER,
  steps              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  browser_session_id TEXT,
  pi_outcome         TEXT,                        -- Pi operation status/reason, e.g. 'done', 'unanswered:turn_limit'
  self_report        TEXT,                        -- model's final message, verbatim
  UNIQUE (batch, model_id, attempt)               -- also serves "all runs of a batch"
);
CREATE INDEX runs_model_day ON runs(model_id, day);  -- per-model history

-- Result per category: one row per (run, prompt), always 7 per finished run.
CREATE TABLE results (
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  day           TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  prompt_id     TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('accepted', 'timed_out', 'not_reached')),
  answer        TEXT,
  tier          TEXT,
  score         INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  ms_to_accept  INTEGER,
  PRIMARY KEY (run_id, prompt_id),
  FOREIGN KEY (day, prompt_id) REFERENCES prompts(day, prompt_id)
);
CREATE INDEX results_day_prompt ON results(day, prompt_id);  -- per-category views
CREATE INDEX results_model_day ON results(model_id, day);    -- per-model views

-- Every submission the browser made, captured from the network by the harness.
CREATE TABLE submissions (
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  seq           INTEGER NOT NULL,
  day           TEXT NOT NULL,
  prompt_id     TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  raw_answer    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('accepted', 'rejected', 'correction', 'error')),
  canonical     TEXT,
  correction    TEXT,
  tier          TEXT,
  score         INTEGER,
  http_status   INTEGER NOT NULL,
  latency_ms    INTEGER NOT NULL,
  clock_ms      INTEGER,                          -- ms since this prompt's answer clock started, when known
  PRIMARY KEY (run_id, seq)                       -- submissions are only read by run_id
);

-- One counted run per (day, model), ranked. Written when a day finalizes.
CREATE TABLE daily_scores (
  day          TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  total_score  INTEGER NOT NULL,
  rank         INTEGER NOT NULL,
  PRIMARY KEY (day, model_id)                     -- daily leaderboard
);
CREATE INDEX daily_scores_model_day ON daily_scores(model_id, day);  -- per-model trend
