CREATE TABLE draws (
  transaction_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  prize_name TEXT NOT NULL,
  fallback_applied INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, timestamp)
);

CREATE TABLE state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  prizes TEXT NOT NULL,
  settings TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
