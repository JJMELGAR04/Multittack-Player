-- Migration 2 - Songs, tracks and sections (phase 2).
-- The full song library (search, tags, key, notes...) arrives in phase 3 and
-- extends these tables with new migrations.

CREATE TABLE songs (
    id                   INTEGER PRIMARY KEY,
    title                TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    -- Tempo of the recording: detected by the analysis or set by the user.
    original_bpm         REAL CHECK (original_bpm IS NULL OR original_bpm BETWEEN 20 AND 400),
    bpm_source           TEXT NOT NULL DEFAULT 'none' CHECK (bpm_source IN ('none', 'detected', 'user')),
    -- First bar line (seconds); defines the bar grid used for sections.
    downbeat_offset_sec  REAL NOT NULL DEFAULT 0 CHECK (downbeat_offset_sec >= 0),
    -- Tempo to play at (NULL = original tempo).
    target_bpm           REAL CHECK (target_bpm IS NULL OR target_bpm BETWEEN 10 AND 800),
    -- 1 once sections were stored at least once (auto or manual), so an
    -- intentionally empty list is not re-filled automatically.
    sections_initialized INTEGER NOT NULL DEFAULT 0 CHECK (sections_initialized IN (0, 1)),
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_opened_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_songs_last_opened ON songs (last_opened_at DESC);

CREATE TABLE song_tracks (
    id         INTEGER PRIMARY KEY,
    song_id    INTEGER NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL CHECK (position >= 0),
    name       TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    UNIQUE (song_id, position)
) STRICT;

CREATE TABLE song_sections (
    id         INTEGER PRIMARY KEY,
    song_id    INTEGER NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    start_sec  REAL NOT NULL CHECK (start_sec >= 0),
    kind       TEXT NOT NULL CHECK (kind IN ('intro', 'verse', 'prechorus', 'chorus', 'bridge', 'interlude', 'outro', 'section')),
    label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
    source     TEXT NOT NULL CHECK (source IN ('auto', 'user'))
) STRICT;

CREATE INDEX idx_song_sections_song ON song_sections (song_id, start_sec);
