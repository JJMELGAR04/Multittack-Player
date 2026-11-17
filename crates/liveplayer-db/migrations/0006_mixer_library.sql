-- Migration 6 - Mixer settings saved per song + data for the song library.

-- Each track keeps its own fader, mute and solo (no pan / groups by design).
ALTER TABLE song_tracks ADD COLUMN volume_db REAL NOT NULL DEFAULT 0 CHECK (volume_db BETWEEN -60 AND 8);
ALTER TABLE song_tracks ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1));
ALTER TABLE song_tracks ADD COLUMN soloed INTEGER NOT NULL DEFAULT 0 CHECK (soloed IN (0, 1));

-- Length of the song (seconds), stored the first time it is loaded.
ALTER TABLE songs ADD COLUMN duration_sec REAL CHECK (duration_sec IS NULL OR duration_sec >= 0);
