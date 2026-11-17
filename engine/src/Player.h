#pragma once

#include "ChunkRing.h"
#include "Limiter.h"
#include "SongRenderer.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>

namespace liveplayer
{

/**
 * Real-time playback of one song.
 *
 * Two threads, decoupled by a lock-free ring (ChunkRing):
 *  - Render thread (RenderThread): runs SongRenderer ~150 ms ahead of the
 *    audio output. Heavy work (time-stretching) happens here, so CPU spikes
 *    are absorbed by the buffer instead of causing dropouts.
 *  - Audio callback (this object): copies ready chunks to the device, sums
 *    tracks, applies the master gain and click-free fades. It never locks,
 *    allocates or touches the disk.
 *
 * Control-thread API (play/pause/seek/...) only writes atomics.
 */
class Player final : public juce::AudioIODeviceCallback
{
public:
    Player();
    ~Player() override;

    /** Installs a song. Call only while the player is NOT attached to a device. */
    void setSong (SongPtr song);
    SongPtr getSong() const { return song; }

    // ---- control thread ----
    void play();
    void pause();
    void stop();
    void seek (double positionSec);
    void setMasterGain (float gain) { masterGainTarget.store (gain); }
    void setTempoRatio (double ratio);

    /** Output routing. Mode 0: everything on 1/2 (rehearsal). Mode 1: instruments
        mono on output 1, click/cues mono on output 2. Mode 2: instruments on 1/2,
        click/cues on 3/4 (needs 4 outputs; falls back to mode 0 otherwise). */
    void setOutputMode (int mode) { outputMode.store (juce::jlimit (0, 2, mode)); }
    /** First device output (0-based) of each bus: stereo modes use it and the
        next one, the split mode only that one. */
    void setOutputChannels (int mainFirst, int monitorFirst)
    {
        mainChannel.store (juce::jmax (0, mainFirst));
        monitorChannel.store (juce::jmax (0, monitorFirst));
    }
    /** Line-check tone (1 kHz, -18 dBFS, 2 s) on one device output; -1 stops it. */
    void startTestTone (int channel)
    {
        toneChannel.store (channel);
        toneSerial.fetch_add (1);
    }
    double getTempoTarget() const noexcept { return tempoTarget.load(); }
    /** Volume of the monitor bus (click / cues), linear. */
    void setMonitorGain (float gain) { monitorGainTarget.store (gain); }
    void setTrackBus (int track, int bus);
    /** Per-track gain (used for solo preview), smoothed over ~10 ms. */
    void setTrackGain (int track, float gain);
    /** Per-song level trim of each bus (headroom so the summed stems never clip). */
    void setBusTrims (float mainBusTrim, float monitorBusTrim)
    {
        mainTrimTarget.store (mainBusTrim);
        monitorTrimTarget.store (monitorBusTrim);
    }
    int getNumTracks() const noexcept { return numTracks; }

    /** Peak levels (linear) with a ~300 ms release: one per track (after its
        gain), then main L/R and monitor L/R (after the limiters). Reading does
        not reset them, so any number of readers see the same values. */
    void takeMeters (std::vector<float>& out);
    int getOutputChannels() const noexcept { return outputChannels.load(); }

    struct Snapshot
    {
        int playState = 0; // 0 stopped, 1 playing, 2 paused
        bool ended = false;
        bool stretching = false;
        double positionSec = 0.0;
        double durationSec = 0.0;
        double tempoRatio = 1.0;
        double masterGain = 1.0;
        double renderLoad = 0.0;
        juce::uint64 underruns = 0;
        bool sampleRateMismatch = false;
        int outputMode = 0;
        int outputChannels = 0;
        double monitorGain = 1.0;
        double mainLimiterGain = 1.0;    // 1 = limiter idle
        double monitorLimiterGain = 1.0;
    };
    Snapshot snapshot() const;

    // ---- juce::AudioIODeviceCallback (audio thread) ----
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                           float* const* outputChannelData, int numOutputChannels,
                                           int numSamples, const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

private:
    class RenderThread;
    friend class RenderThread;

    enum Request { requestStop = 0, requestPlay = 1, requestPause = 2 };
    enum class State { idle, waitingForData, fadingIn, playing, fadingOut };
    enum class AfterFade { pause, stop, seek };

    void discardStaleChunks() noexcept;
    void beginFadeOut (AfterFade after) noexcept;
    int renderSubBlock (float* const* outputs, int numOutputs, int offset, int numSamples) noexcept;

    void finishFadeOut() noexcept;
    void processSong (float* const* outputs, int numOutputs, int numSamples) noexcept;
    void addTestTone (float* const* outputs, int numOutputs, int numSamples) noexcept;

    SongPtr song;
    double songSampleRate = 48000.0;
    double deviceSampleRate = 48000.0;
    juce::int64 songLength = 0;
    int numTracks = 0;
    ChunkRing ring;
    SongRenderer renderer; // render thread only (after setSong)
    std::unique_ptr<RenderThread> renderThread;
    std::atomic<bool> sampleRateMismatch { false };

    // Shared control -> audio/render (atomics only).
    std::atomic<int> request { requestStop };
    std::atomic<uint32_t> seekGeneration { 0 };
    std::atomic<double> seekTarget { 0.0 };  // song samples
    std::atomic<double> tempoTarget { 1.0 };
    std::atomic<float> masterGainTarget { 1.0f };

    // Published by the audio / render threads.
    std::atomic<double> positionSamples { 0.0 };
    std::atomic<int> publishedState { 0 };
    std::atomic<bool> ended { false };
    std::atomic<double> currentRate { 1.0 };
    std::atomic<bool> stretching { false };
    std::atomic<double> renderLoad { 0.0 };
    std::atomic<juce::uint64> underruns { 0 };

    // Audio-thread-only state.
    State state = State::idle;
    AfterFade afterFade = AfterFade::pause;
    uint32_t audioGeneration = 0;
    int readOffset = 0;   // frames already consumed from the current chunk
    float fadeGain = 0.0f; // transport fade 0..1
    float fadeStep = 0.0f;
    juce::LinearSmoothedValue<float> masterGain { 1.0f };
    juce::LinearSmoothedValue<float> monitorGain { 1.0f };
    juce::HeapBlock<float> gainScratch, monitorScratch, rampScratch;
    juce::AudioBuffer<float> busScratch { 4, ChunkRing::chunkFrames }; // main L/R, monitor L/R

    // Routing (control -> audio).
    std::atomic<int> outputMode { 0 };
    std::atomic<int> mainChannel { 0 }, monitorChannel { 1 };
    std::atomic<int> toneChannel { -1 };
    std::atomic<uint32_t> toneSerial { 0 };
    uint32_t toneSeen = 0;      // audio thread
    juce::int64 toneDone = 0;   // samples played of the current tone
    double tonePhase = 0.0;
    std::atomic<float> monitorGainTarget { 1.0f };
    std::atomic<float> mainTrimTarget { 1.0f }, monitorTrimTarget { 1.0f };
    juce::LinearSmoothedValue<float> mainTrim { 1.0f }, monitorTrim { 1.0f };
    Limiter mainLimiter, monitorLimiter;
    std::atomic<float> mainLimiterGain { 1.0f }, monitorLimiterGain { 1.0f };
    std::atomic<int> outputChannels { 0 };
    std::unique_ptr<std::atomic<int>[]> trackBus;
    std::unique_ptr<std::atomic<float>[]> trackGainTarget;
    std::vector<float> trackGain; // audio thread
    std::unique_ptr<std::atomic<float>[]> trackPeak; // audio -> control (max since last read)
    std::atomic<float> busPeak[4] {};
};

} // namespace liveplayer
