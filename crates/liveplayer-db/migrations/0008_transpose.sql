-- Migration 8 - Key changes (phase 5).
-- songs.transpose: semitones the song is played in (0 = recorded key), set in
-- Multitrack Studio. setlist_items.transpose: key for that service only
-- (NULL = the song's own), set in Live Mode.

ALTER TABLE songs ADD COLUMN transpose INTEGER NOT NULL DEFAULT 0 CHECK (transpose BETWEEN -12 AND 12);
ALTER TABLE setlist_items ADD COLUMN transpose INTEGER CHECK (transpose IS NULL OR transpose BETWEEN -12 AND 12);
