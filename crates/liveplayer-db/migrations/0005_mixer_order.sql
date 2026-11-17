-- Migration 5 - Independent order of the mixer strips.
-- The track list (display_order) and the mixer (mixer_order) are arranged
-- separately: moving one never moves the other. Starts equal to the tracks.

ALTER TABLE song_tracks ADD COLUMN mixer_order INTEGER NOT NULL DEFAULT 0;

UPDATE song_tracks SET mixer_order = display_order;
