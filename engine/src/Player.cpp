#include "Player.h"

#include <cmath>

namespace liveplayer
{

namespace
{
constexpr double fadeSeconds = 0.010;    // transport fades (play/pause/stop/seek)
constexpr double lookaheadSeconds = 0.15; // how far ahead the render thread works
constexpr int ringChunks = 128;           // capacity: lookahead + large device buffers

float fadeShape (float x) noexcept
{
    const float s = std::sin (x * juce::MathConstants<float>::halfPi);
    return s * s; // smooth start and end, no clicks
}
} // namespace

//==============================================================================
class Player::RenderThread final : public juce::Thread
{
public:
    explicit RenderThread (Player& p) : juce::Thread ("LIVEPLAYER render"), player (p) {}

    void run() override
    {
        auto& chunks = player.ring;
        auto& songRenderer = player.renderer;
        const int numChannels = chunks.numChannels();
        const int targetChunks = juce::jlimit (4, chunks.numChunks() - 8,
                                               (int) std::ceil (lookaheadSeconds * player.songSampleRate / ChunkRing::chunkFrames));
        std::vector<float*> pointers ((size_t) numChannels);

        uint32_t generation = player.seekGeneration.load (std::memory_order_acquire);
        bool endWritten = false;
        double busySeconds = 0.0, producedSeconds = 0.0;
        const double ticksPerSecond = (double) juce::Time::getHighResolutionTicksPerSecond();

        while (! threadShouldExit())
        {
            const auto g = player.seekGeneration.load (std::memory_order_acquire);
            if (g != generation)
            {
                generation = g;
                songRenderer.seek (player.seekTarget.load(), player.tempoTarget.load());
                endWritten = false;
            }

            if (endWritten || chunks.freeChunks() == 0 || chunks.availableChunks() >= targetChunks)
            {
                wait (2);
                continue;
            }

            const auto start = juce::Time::getHighResolutionTicks();
            for (int c = 0; c < numChannels; ++c)
                pointers[(size_t) c] = chunks.writePointer (c);

            auto& meta = chunks.writeMeta();
            songRenderer.render (pointers.data(), player.tempoTarget.load(), meta);
            meta.generation = generation;
            endWritten = meta.end;
            chunks.commitWrite();

            player.currentRate.store (songRenderer.currentRate());
            player.stretching.store (songRenderer.isStretching());

            // Load = render time / audio time produced (fraction of one core).
            busySeconds += (double) (juce::Time::getHighResolutionTicks() - start) / ticksPerSecond;
            producedSeconds += ChunkRing::chunkFrames / player.songSampleRate;
            if (producedSeconds >= 0.5)
            {
                const double load = busySeconds / producedSeconds;
                const double previous = player.renderLoad.load();
                player.renderLoad.store (previous == 0.0 ? load : previous * 0.6 + load * 0.4);
                busySeconds = producedSeconds = 0.0;
            }
        }
    }

private:
    Player& player;
};

//==============================================================================
Player::Player() = default;

Player::~Player()
{
    if (renderThread != nullptr)
        renderThread->stopThread (2000);
}

void Player::setSong (SongPtr newSong)
{
    if (renderThread != nullptr)
    {
        renderThread->stopThread (5000);
        renderThread.reset();
    }

    renderer.release();
    song = std::move (newSong);
    numTracks = 0;
    songLength = 0;
    request.store (requestStop);
    ended.store (false);
    positionSamples.store (0.0);
    tempoTarget.store (1.0);
    currentRate.store (1.0);
    stretching.store (false);
    renderLoad.store (0.0);
    underruns.store (0);
    state = State::idle;
    readOffset = 0;
    fadeGain = 0.0f;

    if (song == nullptr || song->tracks.empty())
        return;

    songSampleRate = song->sampleRate;
    songLength = song->lengthSamples;
    numTracks = (int) song->tracks.size();
    renderer.prepare (song);
    ring.prepare (numTracks * 2, ringChunks);

    seekTarget.store (0.0);
    audioGeneration = seekGeneration.load();
    renderer.seek (0.0, 1.0);

    renderThread = std::make_unique<RenderThread> (*this);
    renderThread->startThread (juce::Thread::Priority::highest);
}

//==============================================================================
void Player::play()
{
    if (numTracks == 0)
        return;
    if (ended.load())
        seek (0.0);
    request.store (requestPlay);
}

void Player::pause()
{
    if (request.load() == requestPlay)
        request.store (requestPause);
}

void Player::stop()
{
    request.store (requestStop);
    seek (0.0);
}

void Player::seek (double positionSec)
{
    if (numTracks == 0)
        return;
    const double target = juce::jlimit (0.0, (double) songLength, positionSec * songSampleRate);
    ended.store (false);
    seekTarget.store (target);
    seekGeneration.fetch_add (1, std::memory_order_acq_rel);
    if (renderThread != nullptr)
        renderThread->notify();
}

void Player::setTempoRatio (double ratio)
{
    tempoTarget.store (juce::jlimit (0.5, 2.0, ratio));
    // While not playing, re-render the lookahead at the new tempo right away
    // so that playback starts at the right speed.
    if (request.load() != requestPlay && numTracks > 0)
        seek (positionSamples.load() / songSampleRate);
}

Player::Snapshot Player::snapshot() const
{
    Snapshot s;
    const int req = request.load();
    s.ended = ended.load();
    s.playState = s.ended ? 0 : (req == requestPlay ? 1 : (req == requestPause ? 2 : 0));
    s.durationSec = songSampleRate > 0 ? (double) songLength / songSampleRate : 0.0;
    s.positionSec = songSampleRate > 0 ? positionSamples.load() / songSampleRate : 0.0;
    s.tempoRatio = currentRate.load();
    s.stretching = stretching.load();
    s.masterGain = masterGainTarget.load();
    s.renderLoad = renderLoad.load();
    s.underruns = underruns.load();
    s.sampleRateMismatch = sampleRateMismatch.load();
    return s;
}

//==============================================================================
void Player::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    deviceSampleRate = device->getCurrentSampleRate();
    sampleRateMismatch.store (numTracks > 0 && std::abs (deviceSampleRate - songSampleRate) > 0.5);
    gainScratch.allocate ((size_t) ChunkRing::chunkFrames, true);
    masterGain.reset (deviceSampleRate, 0.05);
    masterGain.setCurrentAndTargetValue (masterGainTarget.load());
    fadeStep = (float) (1.0 / (fadeSeconds * deviceSampleRate));
    state = State::idle;
    fadeGain = 0.0f;
}

void Player::audioDeviceStopped() {}

void Player::discardStaleChunks() noexcept
{
    while (ring.availableChunks() > 0 && ring.readMeta().generation != audioGeneration)
    {
        ring.commitRead();
        readOffset = 0;
    }
}

void Player::beginFadeOut (AfterFade after) noexcept
{
    if (state != State::fadingOut)
        state = State::fadingOut;
    if (after == AfterFade::seek || afterFade != AfterFade::seek)
        afterFade = after;
}

void Player::finishFadeOut() noexcept
{
    fadeGain = 0.0f;
    if (afterFade == AfterFade::seek)
    {
        audioGeneration = seekGeneration.load (std::memory_order_acquire);
        readOffset = 0;
        discardStaleChunks();
        positionSamples.store (seekTarget.load());
        state = request.load() == requestPlay ? State::waitingForData : State::idle;
    }
    else
    {
        state = State::idle;
    }
}

int Player::renderSubBlock (float* left, float* right, int maxFrames) noexcept
{
    if (state == State::idle)
        return 0;

    discardStaleChunks();

    if (ring.availableChunks() == 0)
    {
        if (state == State::fadingOut)
            finishFadeOut(); // nothing left to fade: we are already silent
        else if (state != State::waitingForData)
        {
            // The render thread fell behind. Never expected; counted and
            // reported so it can be measured. Resume with a fade in.
            underruns.fetch_add (1);
            state = State::waitingForData;
        }
        return 0;
    }

    const ChunkMeta& meta = ring.readMeta();
    if (meta.end)
    {
        if (state == State::fadingOut)
        {
            finishFadeOut();
            return 0;
        }
        state = State::idle;
        positionSamples.store ((double) songLength);
        ended.store (true);
        return 0;
    }

    if (state == State::waitingForData)
    {
        state = State::fadingIn;
        fadeGain = 0.0f;
    }

    const int n = juce::jmin (maxFrames, ChunkRing::chunkFrames - readOffset);
    int frames = n;
    bool fadeOutFinished = false;
    float* gains = gainScratch.get();

    for (int i = 0; i < n; ++i)
    {
        if (state == State::fadingIn)
        {
            fadeGain += fadeStep;
            if (fadeGain >= 1.0f)
            {
                fadeGain = 1.0f;
                state = State::playing;
            }
        }
        else if (state == State::fadingOut)
        {
            fadeGain -= fadeStep;
            if (fadeGain <= 0.0f)
            {
                fadeGain = 0.0f;
                gains[i] = 0.0f;
                frames = i + 1;
                fadeOutFinished = true;
                break;
            }
        }
        gains[i] = fadeShape (fadeGain) * masterGain.getNextValue();
    }

    for (int t = 0; t < numTracks; ++t)
    {
        const float* srcL = ring.readPointer (t * 2) + readOffset;
        const float* srcR = ring.readPointer (t * 2 + 1) + readOffset;
        if (right != nullptr)
        {
            juce::FloatVectorOperations::addWithMultiply (left, srcL, gains, frames);
            juce::FloatVectorOperations::addWithMultiply (right, srcR, gains, frames);
        }
        else
        {
            for (int i = 0; i < frames; ++i)
                left[i] += 0.5f * (srcL[i] + srcR[i]) * gains[i];
        }
    }

    readOffset += frames;
    positionSamples.store (meta.sourcePos + readOffset * meta.rate);
    if (readOffset >= ChunkRing::chunkFrames)
    {
        ring.commitRead();
        readOffset = 0;
    }

    if (fadeOutFinished)
        finishFadeOut();

    return frames;
}

void Player::audioDeviceIOCallbackWithContext (const float* const*, int,
                                               float* const* outputChannelData, int numOutputChannels,
                                               int numSamples, const juce::AudioIODeviceCallbackContext&)
{
    juce::ScopedNoDenormals noDenormals;

    for (int c = 0; c < numOutputChannels; ++c)
        if (outputChannelData[c] != nullptr)
            juce::FloatVectorOperations::clear (outputChannelData[c], numSamples);

    if (numTracks == 0 || numOutputChannels == 0 || outputChannelData[0] == nullptr || sampleRateMismatch.load())
        return;

    masterGain.setTargetValue (masterGainTarget.load());

    // 1. Seek requests.
    const auto generation = seekGeneration.load (std::memory_order_acquire);
    if (generation != audioGeneration)
    {
        if (state == State::playing || state == State::fadingIn)
            beginFadeOut (AfterFade::seek);
        else if (state != State::fadingOut)
        {
            audioGeneration = generation;
            readOffset = 0;
            discardStaleChunks();
            positionSamples.store (seekTarget.load());
            if (state == State::waitingForData && request.load() != requestPlay)
                state = State::idle;
        }
    }

    // 2. Transport requests.
    const int req = request.load();
    switch (state)
    {
        case State::idle:
            if (req == requestPlay && ! ended.load() && audioGeneration == generation)
                state = State::waitingForData;
            break;
        case State::waitingForData:
            if (req != requestPlay)
                state = State::idle;
            break;
        case State::fadingIn:
        case State::playing:
            if (req == requestPause)
                beginFadeOut (AfterFade::pause);
            else if (req == requestStop)
                beginFadeOut (AfterFade::stop);
            break;
        case State::fadingOut:
            if (req == requestPlay && afterFade != AfterFade::seek)
                state = State::fadingIn; // resumed during the fade: fade back in from here
            break;
    }

    // 3. Audio.
    float* left = outputChannelData[0];
    float* right = numOutputChannels > 1 ? outputChannelData[1] : nullptr;
    int done = 0;
    while (done < numSamples)
    {
        const int n = renderSubBlock (left + done, right != nullptr ? right + done : nullptr, numSamples - done);
        if (n == 0)
            break;
        done += n;
    }

    // Keep the gain smoother in step even while silent.
    if (done < numSamples)
        masterGain.skip (numSamples - done);
}

} // namespace liveplayer
