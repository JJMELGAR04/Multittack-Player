#include "SongRenderer.h"

#include <signalsmith-stretch/signalsmith-stretch.h>

#include <cmath>
#include <semaphore>
#include <thread>

namespace liveplayer
{

namespace
{
constexpr float monoPanGain = 0.70710678f; // -3 dB constant-power centre
constexpr long stretchSeed = 0x4c495645;   // identical seed for every track => identical processing

/** Read-only channel view that returns silence outside the track. */
struct PaddedChannel
{
    const float* data = nullptr;
    juce::int64 start = 0;
    juce::int64 length = 0;

    float operator[] (int i) const noexcept
    {
        const auto k = start + i;
        return (k >= 0 && k < length) ? data[k] : 0.0f;
    }
};

struct PaddedInput
{
    PaddedChannel channel[2];
    PaddedChannel operator[] (int c) const noexcept { return channel[c]; }
};

struct ChannelOutput
{
    float* const* pointers;
    float* operator[] (int c) const noexcept { return pointers[c]; }
};

PaddedInput paddedInput (const juce::AudioBuffer<float>& audio, juce::int64 start)
{
    PaddedInput in;
    for (int c = 0; c < audio.getNumChannels() && c < 2; ++c)
        in.channel[c] = { audio.getReadPointer (c), start, (juce::int64) audio.getNumSamples() };
    return in;
}
} // namespace

struct SongRenderer::Track
{
    const TrackData* data = nullptr;
    bool pitchFixed = false;       // click / cues
    double appliedTranspose = 0.0; // what the stretcher is set to
    signalsmith::stretch::SignalsmithStretch<float> stretch { stretchSeed };

    std::vector<float> mono = std::vector<float> ((size_t) ChunkRing::chunkFrames);

    int channels() const noexcept { return juce::jmin (2, data->audio.getNumChannels()); }
};

/** Renders the second half of the tracks while the render thread does the first. */
class SongRenderer::Helper final : public juce::Thread
{
public:
    explicit Helper (SongRenderer& r) : juce::Thread ("LIVEPLAYER render helper"), owner (r)
    {
        startThread (juce::Thread::Priority::highest);
    }

    ~Helper() override
    {
        signalThreadShouldExit();
        start.release();
        stopThread (2000);
    }

    void run() override
    {
        for (;;)
        {
            start.acquire();
            if (threadShouldExit())
                return;
            for (size_t i = owner.splitIndex; i < owner.tracks.size(); ++i)
                owner.stretchTrack (i, owner.jobOut, owner.jobFrames, owner.jobInCount);
            done.release();
        }
    }

    std::binary_semaphore start { 0 }, done { 0 };

private:
    SongRenderer& owner;
};

SongRenderer::SongRenderer() = default;
SongRenderer::~SongRenderer() { release(); }

void SongRenderer::prepare (SongPtr newSong, bool economy)
{
    song = std::move (newSong);
    tracks.clear();

    for (const auto& t : song->tracks)
    {
        auto track = std::make_unique<Track>();
        track->data = &t;
        // presetDefault (120 ms blocks, 30 ms interval) is the library's
        // higher-quality setting. CPU is not a concern here: rendering runs
        // ahead of time on its own thread.
        if (economy)
            track->stretch.presetCheaper (track->channels(), (float) song->sampleRate, false);
        else
            track->stretch.presetDefault (track->channels(), (float) song->sampleRate);
        // Sung vocals keep their formants (natural voice instead of "chipmunk").
        if (t.voice)
            track->stretch.setFormantSemitones (0, true);
        track->pitchFixed = t.role != roleMusic;
        tracks.push_back (std::move (track));
    }

    crossfadeScratch.setSize (juce::jmax (2, numOutputChannels()), ChunkRing::chunkFrames);

    // Split the tracks in two halves of similar cost (channel count) when the
    // machine has at least 4 hardware threads.
    helper.reset();
    if (tracks.size() >= 4 && std::thread::hardware_concurrency() >= 4)
    {
        int total = 0, acc = 0;
        for (auto& t : tracks) total += t->channels();
        splitIndex = tracks.size();
        for (size_t i = 0; i < tracks.size(); ++i)
        {
            acc += tracks[i]->channels();
            if (acc * 2 >= total) { splitIndex = i + 1; break; }
        }
        helper = std::make_unique<Helper> (*this);
    }
    mode = Mode::direct;
    rate = 1.0;
    transpose = 0.0;
    directPos = 0;
    stretchOutPos = 0.0;
    stretchInFeed = 0;
    crossfadeDone = crossfadeFrames;
}

void SongRenderer::release()
{
    helper.reset();
    tracks.clear();
    song.reset();
}

double SongRenderer::position() const noexcept
{
    return mode == Mode::direct ? (double) directPos : stretchOutPos;
}

void SongRenderer::seek (double sourcePos, double targetRate, double transposeSemitones)
{
    applyTranspose (transposeSemitones);
    sourcePos = juce::jlimit (0.0, (double) song->lengthSamples, sourcePos);
    rate = targetRate; // a jump does not glide
    crossfadeDone = crossfadeFrames;

    if (! needsStretch())
    {
        mode = Mode::direct;
        directPos = std::llround (sourcePos);
    }
    else
    {
        mode = Mode::stretch;
        startStretchAt (sourcePos, rate);
    }
}

void SongRenderer::startStretchAt (double sourcePos, double atRate)
{
    const auto start = (juce::int64) std::llround (sourcePos);
    const int seekLength = tracks.empty() ? 0 : tracks.front()->stretch.outputSeekLength ((float) atRate);

    // outputSeek() pre-rolls each stretcher so that its next output frame is
    // aligned exactly with song sample `start`.
    for (auto& track : tracks)
        track->stretch.outputSeek (paddedInput (track->data->audio, start), seekLength);

    stretchOutPos = (double) start;
    stretchInFeed = start + seekLength;
}

void SongRenderer::setPitchFixed (size_t track, bool fixed) noexcept
{
    if (track < tracks.size())
        tracks[track]->pitchFixed = fixed;
}

bool SongRenderer::needsStretch() const noexcept
{
    if (rate != 1.0)
        return true;
    if (transpose == 0.0)
        return false;
    for (auto& t : tracks)
        if (! t->pitchFixed)
            return true;
    return false;
}

void SongRenderer::applyTranspose (double semitones)
{
    transpose = semitones;
    // Above ~8 kHz the sound is treated as noise (cymbals, breath, air): it
    // keeps its natural texture instead of being "tuned".
    const float tonalityLimit = (float) (8000.0 / song->sampleRate);
    for (auto& t : tracks)
    {
        const double wanted = t->pitchFixed ? 0.0 : semitones;
        if (wanted != t->appliedTranspose)
        {
            t->stretch.setTransposeSemitones ((float) wanted, wanted != 0.0 ? tonalityLimit : 0.0f);
            t->appliedTranspose = wanted;
        }
    }
}

void SongRenderer::updateRate (double targetRate)
{
    if (rate == targetRate)
        return;

    // Exponential glide, ~120 ms time constant.
    const double alpha = 1.0 - std::exp (-(double) ChunkRing::chunkFrames / (0.12 * song->sampleRate));
    double next = rate + (targetRate - rate) * alpha;
    if (std::abs (next - targetRate) < 0.0005)
        next = targetRate;
    rate = next;
}

void SongRenderer::renderDirect (float* const* out, int frames, juce::int64 startPos)
{
    for (size_t i = 0; i < tracks.size(); ++i)
    {
        const auto& audio = tracks[i]->data->audio;
        const int channels = tracks[i]->channels();
        const auto length = (juce::int64) audio.getNumSamples();
        const float gain = channels == 1 && ! tracks[i]->data->dualMono ? monoPanGain : 1.0f;

        const auto first = juce::jlimit<juce::int64> (0, frames, -startPos);              // leading silence
        const auto available = juce::jlimit<juce::int64> (0, frames - first, length - (startPos + first));

        for (int c = 0; c < 2; ++c)
        {
            float* dst = out[i * 2 + (size_t) c];
            juce::FloatVectorOperations::clear (dst, frames);
            if (available > 0)
            {
                const float* src = audio.getReadPointer (juce::jmin (c, channels - 1), (int) (startPos + first));
                juce::FloatVectorOperations::copyWithMultiply (dst + first, src, gain, (int) available);
            }
        }
    }
}

void SongRenderer::renderStretch (float* const* out, int frames, double atRate)
{
    if (tracks.empty())
        return;

    // One block-size decision for all tracks keeps them sample-aligned.
    const auto& reference = tracks.front()->stretch;
    const double outNext = stretchOutPos + frames * atRate;
    const auto feedNext = (juce::int64) std::llround (outNext + reference.inputLatency() + atRate * reference.outputLatency());
    const int inCount = (int) juce::jmax<juce::int64> (0, feedNext - stretchInFeed);

    if (helper != nullptr)
    {
        jobOut = out;
        jobFrames = frames;
        jobInCount = inCount;
        helper->start.release();
        for (size_t i = 0; i < splitIndex; ++i)
            stretchTrack (i, out, frames, inCount);
        helper->done.acquire();
    }
    else
    {
        for (size_t i = 0; i < tracks.size(); ++i)
            stretchTrack (i, out, frames, inCount);
    }

    stretchInFeed += inCount;
    stretchOutPos = outNext;
}

void SongRenderer::stretchTrack (size_t i, float* const* out, int frames, int inCount)
{
    auto& track = *tracks[i];
    const auto input = paddedInput (track.data->audio, stretchInFeed);
    float* left = out[i * 2];
    float* right = out[i * 2 + 1];

    if (track.channels() == 2)
    {
        float* pointers[2] = { left, right };
        track.stretch.process (input, inCount, ChannelOutput { pointers }, frames);
    }
    else
    {
        float* pointers[1] = { track.mono.data() };
        track.stretch.process (input, inCount, ChannelOutput { pointers }, frames);
        const float gain = track.data->dualMono ? 1.0f : monoPanGain;
        juce::FloatVectorOperations::copyWithMultiply (left, pointers[0], gain, frames);
        juce::FloatVectorOperations::copyWithMultiply (right, pointers[0], gain, frames);
    }
}

void SongRenderer::render (float* const* out, double targetRate, double transposeSemitones, ChunkMeta& meta)
{
    constexpr int frames = ChunkRing::chunkFrames;
    updateRate (targetRate);
    applyTranspose (transposeSemitones);

    // Mode changes start a crossfade (never while one is running).
    if (crossfadeDone >= crossfadeFrames)
    {
        if (mode == Mode::direct && needsStretch())
        {
            crossfadeFrom = Mode::direct;
            startStretchAt ((double) directPos, rate);
            mode = Mode::stretch;
            crossfadeDone = 0;
        }
        else if (mode == Mode::stretch && ! needsStretch())
        {
            crossfadeFrom = Mode::stretch;
            directPos = std::llround (stretchOutPos);
            mode = Mode::direct;
            crossfadeDone = 0;
        }
    }

    meta.sourcePos = position();
    meta.rate = mode == Mode::direct ? 1.0 : rate;
    meta.end = meta.sourcePos >= (double) song->lengthSamples;

    if (meta.end)
    {
        for (int c = 0; c < numOutputChannels(); ++c)
            juce::FloatVectorOperations::clear (out[c], frames);
        crossfadeDone = crossfadeFrames;
        return;
    }

    if (mode == Mode::direct)
    {
        renderDirect (out, frames, directPos);
        directPos += frames;
    }
    else
    {
        renderStretch (out, frames, rate);
    }

    if (crossfadeDone < crossfadeFrames)
    {
        // The outgoing path keeps running from its own position.
        auto* const* scratch = crossfadeScratch.getArrayOfWritePointers();
        if (crossfadeFrom == Mode::direct)
        {
            renderDirect (scratch, frames, directPos);
            directPos += frames;
        }
        else
        {
            renderStretch (scratch, frames, rate);
        }

        // Linear crossfade: both paths carry the same (correlated) material.
        for (int c = 0; c < numOutputChannels(); ++c)
        {
            float* dst = out[c];
            const float* old = scratch[c];
            for (int n = 0; n < frames; ++n)
            {
                const float t = (float) (crossfadeDone + n) / (float) crossfadeFrames;
                dst[n] = dst[n] * t + old[n] * (1.0f - t);
            }
        }
        crossfadeDone += frames;
    }
}

} // namespace liveplayer
