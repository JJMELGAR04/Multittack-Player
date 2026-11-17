-- Migration 7 - Song details (Song Editor) and setlists (phase 5).

ALTER TABLE songs ADD COLUMN artist TEXT NOT NULL DEFAULT '' CHECK (length(artist) <= 200);
ALTER TABLE songs ADD COLUMN song_key TEXT NOT NULL DEFAULT '' CHECK (length(song_key) <= 20);
ALTER TABLE songs ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 4000);

CREATE TABLE setlists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    -- ISO date (YYYY-MM-DD) or '' when not set.
    event_date  TEXT NOT NULL DEFAULT '' CHECK (event_date = '' OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    place       TEXT NOT NULL DEFAULT '' CHECK (length(place) <= 200),
    notes       TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- A song can appear more than once in a setlist; removing a song from the
-- library removes it from every setlist.
CREATE TABLE setlist_items (
    id          INTEGER PRIMARY KEY,
    setlist_id  INTEGER NOT NULL REFERENCES setlists (id) ON DELETE CASCADE,
    song_id     INTEGER NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL CHECK (position >= 0),
    notes       TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
    UNIQUE (setlist_id, position)
) STRICT;

CREATE INDEX idx_setlist_items_song ON setlist_items (song_id);
