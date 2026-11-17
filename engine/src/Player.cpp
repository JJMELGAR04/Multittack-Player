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
    const int n = (int) song->tracks.size();
    trackBus = std::make_unique<std::atomic<int>[]> ((size_t) n);
    trackGainTarget = std::make_unique<std::atomic<float>[]> ((size_t) n);
    trackGain.assign ((size_t) n, 1.0f);
    trackPeak = std::make_unique<std::atomic<float>[]> ((size_t) n);
    for (int t = 0; t < n; ++t)
    {
        trackBus[(size_t) t].store (song->tracks[(size_t) t].bus);
        trackGainTarget[(size_t) t].store (1.0f);
        trackPeak[(size_t) t].store (0.0f);
    }
    numTracks = n;
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

void Player::setTrackBus (int track, int bus)
{
    if (track >= 0 && track < numTracks)
        trackBus[(size_t) track].store (bus == busMonitor ? busMonitor : busMain);
}

void Player::takeMeters (std::vector<float>& out)
{
    out.clear();
    for (int t = 0; t < numTracks; ++t)
        out.push_back (trackPeak[(size_t) t].exchange (0.0f));
    for (auto& b : busPeak)
        out.push_back (b.exchange (0.0f));
}

static void storeMax (std::atomic<float>& a, float v) noexcept
{
    float cur = a.load (std::memory_order_relaxed);
    while (v > cur && ! a.compare_exchange_weak (cur, v, std::memory_order_relaxed)) {}
}

void Player::setTrackGain (int track, float gain)
{
    if (track >= 0 && track < numTracks)
        trackGainTarget[(size_t) track].store (juce::jlimit (0.0f, 2.0f, gain));
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
    s.outputMode = outputMode.load();
    s.outputChannels = outputChannels.load();
    s.monitorGain = monitorGainTarget.load();
    s.mainLimiterGain = mainLimiterGain.load();
    s.monitorLimiterGain = monitorLimiterGain.load();
    return s;
}

//==============================================================================
void Player::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    deviceSampleRate = device->getCurrentSampleRate();
    sampleRateMismatch.store (numTracks > 0 && std::abs (deviceSampleRate - songSampleRate) > 0.5);
    gainScratch.allocate ((size_t) ChunkRing::chunkFrames, true);
    monitorScratch.allocate ((size_t) ChunkRing::chunkFrames, true);
    rampScratch.allocate ((size_t) ChunkRing::chunkFrames, true);
    masterGain.reset (deviceSampleRate, 0.05);
    masterGain.setCurrentAndTargetValue (masterGainTarget.load());
    monitorGain.reset (deviceSampleRate, 0.05);
    monitorGain.setCurrentAndTargetValue (monitorGainTarget.load());
    mainTrim.reset (deviceSampleRate, 0.2);
    mainTrim.setCurrentAndTargetValue (mainTrimTarget.load());
    monitorTrim.reset (deviceSampleRate, 0.2);
    monitorTrim.setCurrentAndTargetValue (monitorTrimTarget.load());
    const int lookahead = juce::jmax (8, (int) std::lround (0.001 * deviceSampleRate)); // 1 ms
    mainLimiter.prepare (deviceSampleRate, lookahead);
    monitorLimiter.prepare (deviceSampleRate, lookahead);
    outputChannels.store (device->getActiveOutputChannels().countNumberOfSetBits());
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

int Player::renderSubBlock (float* const* outputs, int numOutputs, int offset, int maxFrames) noexcept
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
    float* monitorGains = monitorScratch.get();

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
                monitorGains[i] = 0.0f;
                frames = i + 1;
                fadeOutFinished = true;
                break;
            }
        }
        const float fade = fadeShape (fadeGain);
        gains[i] = fade * masterGain.getNextValue() * mainTrim.getNextValue();
        monitorGains[i] = fade * monitorGain.getNextValue() * monitorTrim.getNextValue();
    }

    // 1. Sum every track into its bus (per-track gain ramps ~10 ms, never steps).
    busScratch.clear (0, frames);
    float* mainL = busScratch.getWritePointer (0);
    float* mainR = busScratch.getWritePointer (1);
    float* monL = busScratch.getWritePointer (2);
    float* monR = busScratch.getWritePointer (3);
    const float maxStep = (float) (1.0 / (0.01 * deviceSampleRate));
    float* ramp = rampScratch.get();

    for (int t = 0; t < numTracks; ++t)
    {
        const float target = trackGainTarget[(size_t) t].load (std::memory_order_relaxed);
        float& current = trackGain[(size_t) t];
        if (current == 0.0f && target == 0.0f)
            continue;
        const bool monitor = trackBus[(size_t) t].load (std::memory_order_relaxed) == busMonitor;
        float* dstL = monitor ? monL : mainL;
        float* dstR = monitor ? monR : mainR;
        const float* srcL = ring.readPointer (t * 2) + readOffset;
        const float* srcR = ring.readPointer (t * 2 + 1) + readOffset;

        // Track meter: source peak x track gain (fades/master excluded, like a pre-fader-of-master meter).
        {
            const auto rl = juce::FloatVectorOperations::findMinAndMax (srcL, frames);
            const auto rr = juce::FloatVectorOperations::findMinAndMax (srcR, frames);
            const float peak = juce::jmax (std::abs (rl.getStart()), std::abs (rl.getEnd()), std::abs (rr.getStart()), std::abs (rr.getEnd()));
            storeMax (trackPeak[(size_t) t], peak * juce::jmax (current, target) * fadeGain);
        }

        if (current == target)
        {
            juce::FloatVectorOperations::addWithMultiply (dstL, srcL, current, frames);
            juce::FloatVectorOperations::addWithMultiply (dstR, srcR, current, frames);
        }
        else
        {
            for (int i = 0; i < frames; ++i)
            {
                current += juce::jlimit (-maxStep, maxStep, target - current);
                ramp[i] = current;
            }
            juce::FloatVectorOperations::addWithMultiply (dstL, srcL, ramp, frames);
            juce::FloatVectorOperations::addWithMultiply (dstR, srcR, ramp, frames);
        }
    }

    // 2. Bus gains (transport fade x master / monitor volume).
    juce::FloatVectorOperations::multiply (mainL, gains, frames);
    juce::FloatVectorOperations::multiply (mainR, gains, frames);
    juce::FloatVectorOperations::multiply (monL, monitorGains, frames);
    juce::FloatVectorOperations::multiply (monR, monitorGains, frames);

    // Safety limiters (-0.5 dBFS ceiling, 1 ms look-ahead, same latency on both buses).
    mainLimiter.process (mainL, mainR, frames);
    monitorLimiter.process (monL, monR, frames);
    {
        const float* buses[4] = { mainL, mainR, monL, monR };
        for (int b = 0; b < 4; ++b)
        {
            const auto r = juce::FloatVectorOperations::findMinAndMax (buses[b], frames);
            storeMax (busPeak[b], juce::jmax (r.getEnd(), -r.getStart()));
        }
    }

    // 3. Map the buses to the device outputs.
    auto out = [&] (int c) { return outputs[c] != nullptr ? outputs[c] + offset : nullptr; };
    const int mode = outputMode.load (std::memory_order_relaxed);
    if (numOutputs == 1)
    {
        if (auto* o = out (0))
            for (int i = 0; i < frames; ++i)
                o[i] += 0.5f * (mainL[i] + mainR[i] + monL[i] + monR[i]);
    }
    else if (mode == 2 && numOutputs >= 4)
    {
        const float* src[4] = { mainL, mainR, monL, monR };
        for (int c = 0; c < 4; ++c)
            if (auto* o = out (c))
                juce::FloatVectorOperations::add (o, src[c], frames);
    }
    else if (mode == 1)
    {
        // Split: instruments (mono) to output 1, click + cues (mono) to output 2.
        if (auto* o = out (0))
            for (int i = 0; i < frames; ++i)
                o[i] += 0.5f * (mainL[i] + mainR[i]);
        if (auto* o = out (1))
            for (int i = 0; i < frames; ++i)
                o[i] += 0.5f * (monL[i] + monR[i]);
    }
    else
    {
        if (auto* o = out (0))
        {
            juce::FloatVectorOperations::add (o, mainL, frames);
            juce::FloatVectorOperations::add (o, monL, frames);
        }
        if (auto* o = out (1))
        {
            juce::FloatVectorOperations::add (o, mainR, frames);
            juce::FloatVectorOperations::add (o, monR, frames);
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
    monitorGain.setTargetValue (monitorGainTarget.load());
    mainTrim.setTargetValue (mainTrimTarget.load());
    monitorTrim.setTargetValue (monitorTrimTarget.load());

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
    int done = 0;
    while (done < numSamples)
    {
        const int n = renderSubBlock (outputChannelData, numOutputChannels, done, numSamples - done);
        if (n == 0)
            break;
        done += n;
    }

    // Keep the gain smoothers in step even while silent.
    if (done < numSamples)
    {
        masterGain.skip (numSamples - done);
        monitorGain.skip (numSamples - done);
        mainTrim.skip (numSamples - done);
        monitorTrim.skip (numSamples - done);
    }

    // Publish limiter activity (held lowest gain, recovers over ~0.2 s).
    auto publish = [] (std::atomic<float>& meter, float g) {
        const float cur = meter.load (std::memory_order_relaxed);
        meter.store (std::min (g, cur + (1.0f - cur) * 0.05f), std::memory_order_relaxed);
    };
    publish (mainLimiterGain, mainLimiter.takeMinGain());
    publish (monitorLimiterGain, monitorLimiter.takeMinGain());
}

} // namespace liveplayer
