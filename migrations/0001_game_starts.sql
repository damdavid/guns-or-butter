CREATE TABLE game_starts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  nation TEXT NOT NULL,
  continent TEXT NOT NULL,
  level TEXT NOT NULL,
  original_caps INTEGER NOT NULL,
  ip TEXT
);
