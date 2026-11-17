#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <memory>
#include <string>
#include <vector>

namespace liveplayer
{

/** One decoded stem, resident in RAM at the engine (device) sample rate. */
struct TrackData
{
    std::string name;
    std::string path;
    std::string format;          // "WAV", "MP3", ...
    int sourceSampleRate = 0;
    int sourceChannels = 0;
    bool resampled = false;
    int role = 0; // initial role: 0 music, 1 click, 2 guide/cues
    int bus = 0;  // initial output bus: 0 main (instruments), 1 monitor (click / cues)
    bool voice = false; // sung vocals: formants are preserved when transposing
    juce::AudioBuffer<float> audio; // 1 (mono) or 2 (stereo) channels
};

enum TrackRoleCode { roleMusic = 0, roleClick = 1, roleGuide = 2 };
enum BusCode { busMain = 0, busMonitor = 1 };

/** Immutable once built by the loader; shared read-only between threads. */
struct SongData
{
    double sampleRate = 0.0;
    juce::int64 lengthSamples = 0; // longest track
    std::vector<TrackData> tracks;

    double durationSec() const noexcept { return sampleRate > 0 ? (double) lengthSamples / sampleRate : 0.0; }

    size_t memoryBytes() const noexcept
    {
        size_t total = 0;
        for (const auto& t : tracks)
            total += (size_t) t.audio.getNumChannels() * (size_t) t.audio.getNumSamples() * sizeof (float);
        return total;
    }
};

using SongPtr = std::shared_ptr<const SongData>;

/** Track roles inferred from the file name (used by analysis and overview). */
bool isClickTrackName (const std::string& name);
bool isGuideTrackName (const std::string& name);

} // namespace liveplayer
