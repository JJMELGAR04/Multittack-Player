#include "Player.h"

#include <cmath>

namespace liveplayer
{

namespace
{
constexpr double fadeSeconds = 0.010;    // transport fades (play/pause/stop/seek)
constexpr double lookaheadSeconds = 0.15; // how far ahead the render thread works
constexpr int ringChunks = 128;           // capacity: lookahead + large device buffers
constexpr double jumpCrossfadeSeconds = 0.005;

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

        // Seamless jumps: `active` plays, `standby` is started at the target
        // right at the jump sample, both are crossfaded, then they swap roles.
        SongRenderer* active = &songRenderer;
        SongRenderer* standby = &player.altRenderer;
        uint32_t jumpSeen = player.jumpSerial.load (std::memory_order_acquire);
        const int xfadeLen = juce::jmax (16, (int) std::lround (jumpCrossfadeSeconds * player.songSampleRate));
        int tail = 0, xfadeDone = 0; // crossfade frames still to do in the next chunk / already done
        juce::AudioBuffer<float> scratch (numChannels, ChunkRing::chunkFrames);
        ChunkMeta scratchMeta;
        auto blend = [&] (int from, int to) {
            // Old content (scratch) fades out with cos, new (ring) in with sin: equal power.
            for (int k = from; k < to; ++k)
            {
                const float w = juce::jlimit (0.0f, 1.0f, (float) (xfadeDone + k - from) / (float) xfadeLen);
                const float a = std::cos (w * juce::MathConstants<float>::halfPi);
                const float b = std::sin (w * juce::MathConstants<float>::halfPi);
                for (int c = 0; c < numChannels; ++c)
                    pointers[(size_t) c][k] = pointers[(size_t) c][k] * b + scratch.getSample (c, k) * a;
            }
        };
        double busySeconds = 0.0, producedSeconds = 0.0;
        const double ticksPerSecond = (double) juce::Time::getHighResolutionTicksPerSecond();

        while (! threadShouldExit())
        {
            const auto g = player.seekGeneration.load (std::memory_order_acquire);
            if (g != generation)
            {
                generation = g;
                active->seek (player.seekTarget.load(), player.tempoTarget.load(), player.transposeTarget.load());
                endWritten = false;
                tail = 0;
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
            const double tempo = player.tempoTarget.load();
            const double transpose = player.transposeTarget.load();
            for (int t = 0; t < player.numTracks; ++t)
            {
                const bool fixed = player.trackPitchFixed[(size_t) t].load (std::memory_order_relaxed);
                active->setPitchFixed ((size_t) t, fixed);
                standby->setPitchFixed ((size_t) t, fixed);
            }
            const auto js = player.jumpSerial.load (std::memory_order_acquire);
            if (js != jumpSeen)
                jumpSeen = js;

            if (tail > 0)
            {
                // Second half of a jump crossfade: old content still fading out.
                standby->render (scratch.getArrayOfWritePointers(), tempo, transpose, scratchMeta);
                active->render (pointers.data(), tempo, transpose, meta);
                const int n = juce::jmin (tail, ChunkRing::chunkFrames);
                blend (0, n);
                tail = 0;
            }
            else
            {
                // Which jump is armed: a one-shot jump first, else the loop end.
                bool armed = false, oneShot = false;
                double at = 0.0, target = 0.0;
                if (player.jumpActive.load())
                {
                    armed = oneShot = true;
                    at = player.jumpAt.load();
                    target = player.jumpTarget.load();
                }
                else
                {
                    const double ls = player.loopStartSamples.load(), le = player.loopEndSamples.load();
                    if (le > ls && active->nextSourcePos() < le + 0.5) // a chunk may start right on the loop end
                    {
                        armed = true;
                        at = le;
                        target = ls;
                    }
                }

                const double p0 = active->nextSourcePos();
                const double p1 = p0 + ChunkRing::chunkFrames * active->effectiveRate();
                if (armed && oneShot && at < p0 - 0.5)
                {
                    player.jumpActive.store (false); // too late: the render already passed it
                    armed = false;
                }

                if (armed && at < p1)
                {
                    active->render (pointers.data(), tempo, transpose, meta);
                    const int offset = juce::jlimit (0, ChunkRing::chunkFrames,
                                                     (int) std::floor ((at - meta.sourcePos) / meta.rate + 0.5));
                    standby->seek (juce::jmax (0.0, target - offset * meta.rate), tempo, transpose);
                    // Old content (A) goes to scratch, new (B) into the ring.
                    for (int c = 0; c < numChannels; ++c)
                        scratch.copyFrom (c, 0, pointers[(size_t) c], ChunkRing::chunkFrames);
                    standby->render (pointers.data(), tempo, transpose, scratchMeta);
                    for (int c = 0; c < numChannels; ++c)
                        for (int k = 0; k < offset; ++k)
                            pointers[(size_t) c][k] = scratch.getSample (c, k); // before the jump: A only
                    xfadeDone = 0;
                    blend (offset, ChunkRing::chunkFrames);
                    xfadeDone = ChunkRing::chunkFrames - offset;
                    tail = juce::jmax (0, xfadeLen - xfadeDone);
                    std::swap (active, standby);
                    meta.end = scratchMeta.end;
                    if (oneShot)
                        player.jumpActive.store (false);
                    player.jumpsDone.fetch_add (1);
                }
                else
                {
                    active->render (pointers.data(), tempo, transpose, meta);
                }
            }
            meta.generation = generation;
            endWritten = meta.end;
            chunks.commitWrite();

            player.currentRate.store (active->currentRate());
            player.stretching.store (active->isStretching());

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
    altRenderer.release();
    jumpActive.store (false);
    loopStartSamples.store (0.0);
    loopEndSamples.store (0.0);
    song = std::move (newSong);
    numTracks = 0;
    songLength = 0;
    request.store (requestStop);
    ended.store (false);
    positionSamples.store (0.0);
    tempoTarget.store (1.0);
    transposeTarget.store (0.0);
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
    trackPitchFixed = std::make_unique<std::atomic<bool>[]> ((size_t) n);
    for (int t = 0; t < n; ++t)
    {
        trackBus[(size_t) t].store (song->tracks[(size_t) t].bus);
        trackGainTarget[(size_t) t].store (1.0f);
        trackPeak[(size_t) t].store (0.0f);
        trackPitchFixed[(size_t) t].store (song->tracks[(size_t) t].role != roleMusic);
    }
    numTracks = n;
    renderer.prepare (song);
    altRenderer.prepare (song);
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
    jumpActive.store (false);
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
        out.push_back (trackPeak[(size_t) t].load (std::memory_order_relaxed));
    for (auto& b : busPeak)
        out.push_back (b.load (std::memory_order_relaxed));
}

static void storeMax (std::atomic<float>& a, float v) noexcept
{
    float cur = a.load (std::memory_order_relaxed);
    while (v > cur && ! a.compare_exchange_weak (cur, v, std::memory_order_relaxed)) {}
}

void Player::setTrackPitchFixed (int track, bool fixed)
{
    if (track >= 0 && track < numTracks)
        trackPitchFixed[(size_t) track].store (fixed);
}

void Player::setTranspose (double semitones)
{
    transposeTarget.store (juce::jlimit (-12.0, 12.0, semitones));
    // While not playing, re-render the lookahead in the new key right away.
    if (request.load() != requestPlay && numTracks > 0)
        seek (positionSamples.load() / songSampleRate);
}

void Player::setTrackGain (int track, float gain)
{
    if (track >= 0 && track < numTracks)
        trackGainTarget[(size_t) track].store (juce::jlimit (0.0f, 4.0f, gain));
}

void Player::setTempoRatio (double ratio)
{
    tempoTarget.store (juce::jlimit (0.5, 2.0, ratio));
    // While not playing, re-render the lookahead at the new tempo right away
    // so that playback starts at the right speed.
    if (request.load() != requestPlay && numTracks > 0)
        seek (positionSamples.load() / songSampleRate);
}

double Player::minJumpLeadSeconds() const noexcept
{
    // The render thread works up to ~lookahead ahead (in real time) plus a
    // chunk; in song time that scales with the tempo.
    return (lookaheadSeconds + 0.1) * juce::jmax (1.0, tempoTarget.load());
}

bool Player::scheduleJump (double atSec, double targetSec)
{
    if (numTracks == 0 || request.load() != requestPlay)
        return false;
    const double pos = positionSamples.load() / songSampleRate;
    if (atSec < pos + minJumpLeadSeconds() || atSec * songSampleRate > (double) songLength)
        return false;
    jumpAt.store (atSec * songSampleRate);
    jumpTarget.store (juce::jlimit (0.0, (double) songLength, targetSec * songSampleRate));
    jumpActive.store (true);
    jumpSerial.fetch_add (1, std::memory_order_acq_rel);
    return true;
}

void Player::cancelJump()
{
    jumpActive.store (false);
    jumpSerial.fetch_add (1, std::memory_order_acq_rel);
}

void Player::setLoop (double startSec, double endSec)
{
    if (endSec <= startSec || numTracks == 0)
    {
        loopEndSamples.store (0.0);
        loopStartSamples.store (0.0);
        return;
    }
    loopStartSamples.store (juce::jlimit (0.0, (double) songLength, startSec * songSampleRate));
    loopEndSamples.store (juce::jlimit (0.0, (double) songLength, endSec * songSampleRate));
}

Player::Snapshot Player::snapshot() const
{
    Snapshot s;
    if (jumpActive.load() && songSampleRate > 0)
    {
        s.pendingJumpAt = jumpAt.load() / songSampleRate;
        s.pendingJumpTarget = jumpTarget.load() / songSampleRate;
    }
    if (loopEndSamples.load() > loopStartSamples.load() && songSampleRate > 0)
    {
        s.loopStart = loopStartSamples.load() / songSampleRate;
        s.loopEnd = loopEndSamples.load() / songSampleRate;
    }
    s.jumpsDone = jumpsDone.load();
    const int req = request.load();
    s.ended = ended.load();
    s.playState = s.ended ? 0 : (req == requestPlay ? 1 : (req == requestPause ? 2 : 0));
    s.durationSec = songSampleRate > 0 ? (double) songLength / songSampleRate : 0.0;
    s.positionSec = songSampleRate > 0 ? positionSamples.load() / songSampleRate : 0.0;
    s.tempoRatio = currentRate.load();
    s.transpose = transposeTarget.load();
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

    // 3. Map the buses to the device outputs chosen by the user
    //    (outputs that do not exist on the device are skipped).
    auto out = [&] (int c) { return c >= 0 && c < numOutputs && outputs[c] != nullptr ? outputs[c] + offset : nullptr; };
    const int mode = outputMode.load (std::memory_order_relaxed);
    const int mainCh = mainChannel.load (std::memory_order_relaxed);
    const int monCh = monitorChannel.load (std::memory_order_relaxed);
    if (numOutputs == 1)
    {
        if (auto* o = out (0))
            for (int i = 0; i < frames; ++i)
                o[i] += 0.5f * (mainL[i] + mainR[i] + monL[i] + monR[i]);
    }
    else if (mode == 2 && numOutputs >= 4)
    {
        // Instruments in stereo on one pair, click + cues in stereo on another.
        const float* src[4] = { mainL, mainR, monL, monR };
        const int dst[4] = { mainCh, mainCh + 1, monCh, monCh + 1 };
        for (int c = 0; c < 4; ++c)
            if (auto* o = out (dst[c]))
                juce::FloatVectorOperations::add (o, src[c], frames);
    }
    else if (mode == 1)
    {
        // Split: instruments (mono) to one output, click + cues (mono) to another.
        if (auto* o = out (mainCh))
            for (int i = 0; i < frames; ++i)
                o[i] += 0.5f * (mainL[i] + mainR[i]);
        if (auto* o = out (monCh))
            for (int i = 0; i < frames; ++i)
                o[i] += 0.5f * (monL[i] + monR[i]);
    }
    else
    {
        if (auto* o = out (mainCh))
        {
            juce::FloatVectorOperations::add (o, mainL, frames);
            juce::FloatVectorOperations::add (o, monL, frames);
        }
        if (auto* o = out (mainCh + 1))
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

    processSong (outputChannelData, numOutputChannels, numSamples);
    addTestTone (outputChannelData, numOutputChannels, numSamples);
}

void Player::addTestTone (float* const* outputs, int numOutputs, int numSamples) noexcept
{
    const auto serial = toneSerial.load (std::memory_order_acquire);
    if (serial != toneSeen)
    {
        toneSeen = serial;
        toneDone = 0;
        tonePhase = 0.0;
    }
    const int ch = toneChannel.load (std::memory_order_relaxed);
    const auto total = (juce::int64) (2.0 * deviceSampleRate);
    if (ch < 0 || ch >= numOutputs || outputs[ch] == nullptr || toneDone >= total)
        return;

    // 1 kHz at -18 dBFS (the usual line-up level), 10 ms fades: no clicks.
    constexpr float level = 0.1259f;
    const double inc = juce::MathConstants<double>::twoPi * 1000.0 / deviceSampleRate;
    const auto fade = (juce::int64) (0.01 * deviceSampleRate);
    auto* o = outputs[ch];
    for (int i = 0; i < numSamples && toneDone < total; ++i, ++toneDone)
    {
        const auto edge = juce::jmin (toneDone, total - 1 - toneDone);
        const float env = edge < fade ? (float) edge / (float) fade : 1.0f;
        o[i] += level * env * (float) std::sin (tonePhase);
        tonePhase += inc;
        if (tonePhase > juce::MathConstants<double>::twoPi)
            tonePhase -= juce::MathConstants<double>::twoPi;
    }
}

void Player::processSong (float* const* outputChannelData, int numOutputChannels, int numSamples) noexcept
{
    if (numTracks == 0 || numOutputChannels == 0 || outputChannelData[0] == nullptr || sampleRateMismatch.load())
        return;

    masterGain.setTargetValue (masterGainTarget.load());
    monitorGain.setTargetValue (monitorGainTarget.load());

    // Meter release: peaks decay with a ~300 ms time constant (held by storeMax below).
    {
        const float decay = std::exp (-(float) numSamples / (0.3f * (float) deviceSampleRate));
        for (int t = 0; t < numTracks; ++t)
            trackPeak[(size_t) t].store (trackPeak[(size_t) t].load (std::memory_order_relaxed) * decay, std::memory_order_relaxed);
        for (auto& b : busPeak)
            b.store (b.load (std::memory_order_relaxed) * decay, std::memory_order_relaxed);
    }
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
