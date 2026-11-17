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

Input prepareInput (const SongData& song);
Tempo detectTempo (const Input& input);
/** `tempo` may come from detectTempo() or be user-confirmed. */
std::vector<Section> detectSections (const Input& input, const Tempo& tempo);

} // namespace liveplayer::analysis
