#pragma once

#include "SongData.h"

#include <string>
#include <vector>

namespace liveplayer::analysis
{

/** Mono analysis signals at a reduced sample rate. */
struct Input
{
    double sampleRate = 22050.0;
    std::vector<float> music; // mix of musical tracks (no click / guide)
    std::vector<float> click; // click track, empty if none
};

struct Tempo
{
    bool valid = false;
    double bpm = 0.0;
    double confidence = 0.0;     // 0..1
    double beatOffsetSec = 0.0;  // first beat
    double downbeatOffsetSec = 0.0; // first bar line (4/4 assumed)
    std::string source;          // "click" or "mix"
};

struct Section
{
    double startSec = 0.0;
    double endSec = 0.0;
    std::string kind;  // intro, verse, prechorus, chorus, bridge, interlude, outro, section
    std::string label; // display name in Spanish ("Coro 2")
    double confidence = 0.0;
};

/** Analysis role of each track (index-aligned with SongData::tracks). */
enum class TrackRole { music, click, guide };

/** Empty `roles` = infer from the file names. */
Input prepareInput (const SongData& song, const std::vector<TrackRole>& roles);
/** Estimates BPM, beat phase and the first bar line (`beatsPerBar` beats per bar). */
Tempo detectTempo (const Input& input, int beatsPerBar = 4);
/** Uses a known BPM (from the user) and only estimates the beat phase and first bar line. */
Tempo alignTempo (const Input& input, double bpm, int beatsPerBar = 4);
/** `tempo` may come from detectTempo() / alignTempo() or be fully user-confirmed. */
std::vector<Section> detectSections (const Input& input, const Tempo& tempo, int beatsPerBar = 4);

} // namespace liveplayer::analysis
