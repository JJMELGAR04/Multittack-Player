#pragma once

#include "ChunkRing.h"
#include "SongData.h"

#include <memory>
#include <vector>

namespace liveplayer
{

/**
 * Renders every track of a song, chunk by chunk, at a (possibly changing)
 * playback rate. Runs on the render thread only — never on the audio thread.
 *
 *  - rate == 1.0 exactly: "direct" mode, the original samples are copied
 *    untouched (bit-exact, no processing, no CPU cost).
 *  - otherwise: "stretch" mode, each track goes through its own Signalsmith
 *    Stretch instance (pitch preserved). All instances share configuration,
 *    random seed and the exact same input/output block sizes, so every track
 *    stays sample-aligned with the others.
 *  - switching modes renders both paths for a short span and crossfades.
 *  - rate changes glide (no sudden jumps).
 *
 * Output layout: 2 channels per track (L, R). Mono tracks are centred with a
 * -3 dB constant-power pan law.
 */
class SongRenderer
{
public:
    SongRenderer();
    ~SongRenderer();

    /** Allocates everything needed for `song`. Not real-time safe. */
    void prepare (SongPtr song);
    void release();

    bool isPrepared() const noexcept { return song != nullptr; }
    int numOutputChannels() const noexcept { return (int) tracks.size() * 2; }

    /** Repositions playback so the next rendered frame is song sample `sourcePos`. */
    void seek (double sourcePos, double targetRate);

    /** Renders ChunkRing::chunkFrames frames for every track into `out`. */
    void render (float* const* out, double targetRate, ChunkMeta& meta);

    double currentRate() const noexcept { return rate; }
    bool isStretching() const noexcept { return mode == Mode::stretch; }
    bool isAtEnd() const noexcept { return position() >= (double) song->lengthSamples; }

private:
    enum class Mode { direct, stretch };
    struct Track;
    class Helper;
    friend class Helper;

    double position() const noexcept;
    void startStretchAt (double sourcePos, double atRate);
    void renderDirect (float* const* out, int frames, juce::int64 startPos);
    void renderStretch (float* const* out, int frames, double atRate);
    void stretchTrack (size_t index, float* const* out, int frames, int inCount);
    void updateRate (double targetRate);

    SongPtr song;
    std::vector<std::unique_ptr<Track>> tracks;

    Mode mode = Mode::direct;
    double rate = 1.0;
    juce::int64 directPos = 0;
    double stretchOutPos = 0.0;      // song position of the next stretched output frame
    juce::int64 stretchInFeed = 0;   // next song sample to feed the stretchers

    // Crossfade between modes.
    static constexpr int crossfadeFrames = ChunkRing::chunkFrames * 4; // ~21 ms @ 48 kHz
    int crossfadeDone = crossfadeFrames;
    Mode crossfadeFrom = Mode::direct;
    juce::AudioBuffer<float> crossfadeScratch;

    // Second render thread: time-stretching is split across two cores.
    std::unique_ptr<Helper> helper;
    size_t splitIndex = 0;          // tracks [splitIndex, n) go to the helper
    float* const* jobOut = nullptr;
    int jobFrames = 0, jobInCount = 0;
};

} // namespace liveplayer
