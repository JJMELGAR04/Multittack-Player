#pragma once

#include "SongData.h"

#include <juce_core/juce_core.h>

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace liveplayer
{

struct TrackRequest
{
    std::string path;
    std::string name;
    int role = -1; // TrackRoleCode, -1 = infer from the name
    int bus = -1;  // BusCode, -1 = click/guide -> monitor, music -> main
    bool voice = false; // sung vocals (formant-preserving transposition)

    bool operator== (const TrackRequest& o) const
    {
        return path == o.path && name == o.name && role == o.role && bus == o.bus && voice == o.voice;
    }
};

/** Gapless information of an MP3 written by LAME / FFmpeg ("Info"/"Xing" + LAME tag). */
struct Mp3GaplessInfo
{
    bool valid = false;
    int encoderDelay = 0;   // samples
    int encoderPadding = 0; // samples
    juce::int64 frames = 0; // audio frames (excluding the tag frame), 0 if unknown
    int samplesPerFrame = 1152;
};
Mp3GaplessInfo readMp3GaplessInfo (const juce::File& file);

/** Samples the JUCE (mpglib-derived) MP3 decoder adds before the first sample. */
constexpr int mp3DecoderDelay = 529;

/**
 * Decodes all tracks of a song on a background thread (several files in
 * parallel), converts them to the engine sample rate with r8brain, and
 * computes waveform overviews. Results are read by the control thread.
 */
class SongLoader final : public juce::Thread
{
public:
    SongLoader (std::vector<TrackRequest> tracks, double targetSampleRate, juce::uint64 loadId);
    ~SongLoader() override;

    enum class Phase { loading, ready, failed };

    juce::uint64 getLoadId() const noexcept { return loadId; }
    Phase getPhase() const noexcept { return phase.load(); }
    float getProgress() const noexcept { return progress.load(); }

    /** Valid once getPhase() == ready. */
    SongPtr getSong() const;
    std::vector<std::vector<juce::uint8>> takeTrackPeaks();
    std::vector<juce::uint8> takeMixPeaks();
    std::string getError() const;

    void run() override;

private:
    bool decodeTrack (size_t index, TrackData& out, std::string& error);
    void fail (std::string message);

    const std::vector<TrackRequest> requests;
    const double sampleRate;
    const juce::uint64 loadId;

    std::atomic<Phase> phase { Phase::loading };
    std::atomic<float> progress { 0.0f };
    std::vector<std::atomic<float>> trackProgress;

    mutable std::mutex mutex;
    SongPtr song;
    std::vector<std::vector<juce::uint8>> trackPeaks;
    std::vector<juce::uint8> mixPeaks;
    std::string error;
};

/** Sample peak of the stereo sum of the tracks routed to `bus` (mono tracks at -3 dB). */
float computeBusPeak (const SongData& song, const std::vector<int>& buses, int bus);

/** Overview of the musical tracks (roles[i] == roleMusic); all tracks if none is musical. */
std::vector<juce::uint8> computeMixPeaks (const SongData& song, const std::vector<int>& roles);

/** Peak overview (0..255 linear) with `hop` samples per bucket. */
std::vector<juce::uint8> computePeaks (const juce::AudioBuffer<float>& audio, int hop, float gain = 1.0f);

} // namespace liveplayer
