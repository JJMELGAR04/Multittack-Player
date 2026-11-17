-- Migration 3 - Track roles / output buses, time signature, imported archives.

ALTER TABLE songs ADD COLUMN time_signature TEXT NOT NULL DEFAULT '4/4'
    CHECK (time_signature IN ('2/4', '3/4', '4/4', '5/4', '6/8', '12/8'));

-- Zip file the song was imported from (to recognise a re-import), if any.
ALTER TABLE songs ADD COLUMN source_archive TEXT;

-- What each file is (chosen or confirmed by the user on import).
ALTER TABLE song_tracks ADD COLUMN role TEXT NOT NULL DEFAULT 'other'
    CHECK (role IN ('drums', 'percussion', 'bass', 'electric_guitar', 'acoustic_guitar', 'piano', 'keys',
                    'pads', 'synth', 'strings', 'brass', 'lead_vocal', 'backing_vocals', 'loops',
                    'backing_track', 'click', 'cues', 'other'));

-- Output bus: 'main' = instruments (PA), 'monitor' = click and cues (band in-ears only).
ALTER TABLE song_tracks ADD COLUMN bus TEXT NOT NULL DEFAULT 'main' CHECK (bus IN ('main', 'monitor'));

-- Songs created in migration 2 had no roles: recognise click and cue tracks by name.
UPDATE song_tracks SET role = 'click', bus = 'monitor'
    WHERE lower(name) LIKE '%click%' OR lower(name) LIKE '%clic%' OR lower(name) LIKE '%metr%';
UPDATE song_tracks SET role = 'cues', bus = 'monitor'
    WHERE role = 'other' AND lower(name) NOT LIKE '%cuerd%'
      AND (lower(name) LIKE '%guide%' OR lower(name) LIKE '%guia%' OR lower(name) LIKE '%cue%');
