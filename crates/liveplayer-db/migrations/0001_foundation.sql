-- Migration 1 - Foundation (phase 1).
-- Only infrastructure tables. Domain tables (songs, tracks, setlists, output
-- assignments, markers) are added by later migrations in their own phases so
-- the schema is designed together with the features that use it.

CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,              -- JSON-encoded value
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
