CREATE TABLE callbacks (
  state TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
