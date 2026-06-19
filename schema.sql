CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_key TEXT NOT NULL,
  author       TEXT NOT NULL DEFAULT 'Anonymous',
  rating       INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_key
  ON comments(restaurant_key, created_at DESC);
