CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  protocol_id    TEXT NOT NULL,
  protocol_title TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  text           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  approved       INTEGER NOT NULL DEFAULT 0,
  resolved       INTEGER NOT NULL DEFAULT 0,
  resolved_at    TEXT,
  visitor        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_public  ON comments (protocol_id, approved, resolved, created_at);
CREATE INDEX IF NOT EXISTS comments_visitor ON comments (visitor, created_at);
CREATE INDEX IF NOT EXISTS comments_review  ON comments (resolved, created_at);
