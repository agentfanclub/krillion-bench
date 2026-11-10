-- One row per coordinator batch (a real day or a manual trial), for the admin portal's
-- "recent batches" list. Read newest-first through batches_created.
CREATE TABLE batches (
  batch       TEXT PRIMARY KEY,
  day         TEXT,                 -- set once the game is fetched (trials learn it at dispatch)
  trial       INTEGER NOT NULL,
  models      TEXT,                 -- JSON array when restricted to some models, else NULL
  created_by  TEXT,                 -- 'cron' or the admin's email
  created_at  TEXT NOT NULL
);
CREATE INDEX batches_created ON batches(created_at);
