-- Migration 4 - Display order of the tracks (the user can drag them).
-- `position` stays the load order (engine track index); `display_order` is
-- only how the tracks are shown. Default: click first, cues second, then the band.

ALTER TABLE song_tracks ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

UPDATE song_tracks SET display_order = position + CASE role WHEN 'click' THEN 0 WHEN 'cues' THEN 1000 ELSE 2000 END;
