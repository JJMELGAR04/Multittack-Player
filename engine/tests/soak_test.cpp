// Endurance ("soak") test: plays songs for a long time while doing what a
// service does - song changes, part jumps, loops, tempo and key changes, fader
// moves - and checks that nothing degrades: no dropouts, no invalid samples,
// no clipping past the limiter, no memory growth.
//
// Usage: liveplayer_soak <test-audio-dir> [minutes-of-audio=3] [speed=4]
//   speed = how many times faster than real time the audio callback runs
//   (the render thread must keep up, which is a stricter test than real time).

#include "Player.h"
#include "SongLoader.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

#if JUCE_WINDOWS
 #include <windows.h>
 #include <psapi.h>
 #pragma comment(lib, "psapi.lib")
#elif JUCE_MAC
 #include <mach/mach.h>
#endif

using namespace liveplayer;

namespace
{
constexpr double rate = 48000.0;
constexpr int block = 480;

double processMemoryMB()
{
#if JUCE_WINDOWS
    PROCESS_MEMORY_COUNTERS_EX pmc {};
    if (GetProcessMemoryInfo (GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS*) &pmc, sizeof (pmc)))
        return (double) pmc.PrivateUsage / 1048576.0;
#elif JUCE_MAC
    task_vm_info_data_t info {};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info (mach_task_self(), TASK_VM_INFO, (task_info_t) &info, &count) == KERN_SUCCESS)
        return (double) info.phys_footprint / 1048576.0;
#endif
    return 0.0;
}

class FakeDevice final : public juce::AudioIODevice
{
public:
    FakeDevice() : juce::AudioIODevice ("Soak", "Soak") {}
    juce::StringArray getOutputChannelNames() override { return { "1", "2" }; }
    juce::StringArray getInputChannelNames() override { return {}; }
    juce::Array<double> getAvailableSampleRates() override { return { rate }; }
    juce::Array<int> getAvailableBufferSizes() override { return { block }; }
    int getDefaultBufferSize() override { return block; }
    juce::String open (const juce::BigInteger&, const juce::BigInteger&, double, int) override { return {}; }
    void close() override {}
    bool isOpen() override { return true; }
    void start (juce::AudioIODeviceCallback*) override {}
    void stop() override {}
    bool isPlaying() override { return true; }
    juce::String getLastError() override { return {}; }
    int getCurrentBufferSizeSamples() override { return block; }
    double getCurrentSampleRate() override { return rate; }
    int getCurrentBitDepth() override { return 32; }
    juce::BigInteger getActiveOutputChannels() const override { juce::BigInteger b; b.setRange (0, 2, true); return b; }
    juce::BigInteger getActiveInputChannels() const override { return 0; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }
};

SongPtr load (const juce::File& dir)
{
    std::vector<TrackRequest> req;
    for (const auto& f : dir.findChildFiles (juce::File::findFiles, false, "*.wav"))
        req.push_back ({ f.getFullPathName().toStdString(), f.getFileNameWithoutExtension().toStdString() });
    std::sort (req.begin(), req.end(), [] (const TrackRequest& a, const TrackRequest& b) { return a.name < b.name; });
    SongLoader loader (req, rate, 1);
    loader.startThread();
    while (loader.getPhase() == SongLoader::Phase::loading)
        juce::Thread::sleep (10);
    return loader.getPhase() == SongLoader::Phase::ready ? loader.getSong() : nullptr;
}
} // namespace

int main (int argc, char** argv)
{
    if (argc < 2)
    {
        std::fprintf (stderr, "usage: %s <test-audio-dir> [minutes] [speed]\n", argv[0]);
        return 2;
    }
    const juce::File dir (juce::String::fromUTF8 (argv[1]));
    const double minutes = argc > 2 ? std::atof (argv[2]) : 3.0;
    const double speed = argc > 3 ? std::max (1.0, std::atof (argv[3])) : 4.0;

    const SongPtr songs[2] = { load (dir.getChildFile ("song")), load (dir.getChildFile ("short")) };
    if (songs[0] == nullptr || songs[1] == nullptr)
    {
        std::fprintf (stderr, "missing test audio; run: node tools/generate-test-song.mjs %s\n", argv[1]);
        return 2;
    }

    Player player;
    FakeDevice device;
    int current = 0;
    player.setSong (songs[current]);
    player.audioDeviceAboutToStart (&device);
    player.play();

    std::mt19937 rng (12345);
    auto chance = [&] (double p) { return std::uniform_real_distribution<double> (0, 1) (rng) < p; };
    auto uniform = [&] (double a, double b) { return std::uniform_real_distribution<double> (a, b) (rng); };

    juce::AudioBuffer<float> out (2, block);
    const auto totalBlocks = (juce::int64) (minutes * 60.0 * rate / block);
    const auto blockTime = std::chrono::duration<double> (block / rate / speed);
    juce::uint64 badSamples = 0, underrunsTotal = 0;
    float peak = 0.0f;
    int songChanges = 0, jumps = 0, loops = 0, tempoChanges = 0, keyChanges = 0, faderMoves = 0;
    double memoryAfterWarmup = 0.0, memoryMax = 0.0;
    int harnessStalls = 0; // the test thread itself was held up (busy computer)
    auto next = std::chrono::steady_clock::now();

    for (juce::int64 b = 0; b < totalBlocks; ++b)
    {
        // About one action every 2 s of audio.
        if (b % 200 == 0 && b > 0)
        {
            const auto snap = player.snapshot();
            const double dur = snap.durationSec;
            if (chance (0.06))
            {
                // Song change (the player is detached first, like the engine does).
                underrunsTotal += snap.underruns;
                player.audioDeviceStopped();
                current = 1 - current;
                player.setSong (songs[current]);
                player.audioDeviceAboutToStart (&device);
                player.play();
                ++songChanges;
            }
            else if (chance (0.3) && snap.playState == 1)
            {
                const double at = snap.positionSec + player.minJumpLeadSeconds() + uniform (0.1, 2.0);
                if (at < dur - 1.0 && player.scheduleJump (at, uniform (0.0, dur - 3.0)))
                    ++jumps;
            }
            else if (chance (0.2))
            {
                if (snap.loopEnd > 0.0)
                    player.setLoop (0.0, 0.0);
                else
                {
                    const double s = uniform (0.0, std::max (0.0, dur - 4.0));
                    player.setLoop (s, s + uniform (1.0, 3.0));
                }
                ++loops;
            }
            else if (chance (0.3))
            {
                player.setTempoRatio (chance (0.4) ? 1.0 : uniform (0.85, 1.15));
                ++tempoChanges;
            }
            else if (chance (0.4))
            {
                player.setTranspose (chance (0.4) ? 0.0 : (double) std::uniform_int_distribution<int> (-3, 3) (rng));
                ++keyChanges;
            }
            else
            {
                player.setTrackGain (std::uniform_int_distribution<int> (0, std::max (0, player.getNumTracks() - 1)) (rng), (float) uniform (0.0, 1.5));
                ++faderMoves;
            }
            if (snap.ended || snap.playState != 1)
            {
                player.seek (0.0);
                player.play();
            }
        }

        player.audioDeviceIOCallbackWithContext (nullptr, 0, out.getArrayOfWritePointers(), 2, block, {});
        for (int c = 0; c < 2; ++c)
        {
            const float* d = out.getReadPointer (c);
            for (int i = 0; i < block; ++i)
            {
                if (! std::isfinite (d[i]))
                    ++badSamples;
                else
                    peak = std::max (peak, std::abs (d[i]));
            }
        }

        if (b == totalBlocks / 10)
            memoryAfterWarmup = processMemoryMB();
        if (b % 1000 == 0)
            memoryMax = std::max (memoryMax, processMemoryMB());
        if (b % (juce::int64) (60.0 * rate / block) == 0 && b > 0)
            std::printf ("  %.0f min: memory %.1f MB, peak %.3f, underruns %llu\n", b * block / rate / 60.0, processMemoryMB(), peak,
                         (unsigned long long) (underrunsTotal + player.snapshot().underruns));

        next += std::chrono::duration_cast<std::chrono::steady_clock::duration> (blockTime);
        std::this_thread::sleep_until (next);
        // A real sound card never "catches up" by running faster after a hiccup
        // of this (normal-priority) test thread: it simply continues from now.
        const auto now = std::chrono::steady_clock::now();
        if (now - next > std::chrono::milliseconds (50))
        {
            next = now;
            ++harnessStalls;
        }
    }
    underrunsTotal += player.snapshot().underruns;
    player.audioDeviceStopped();
    const double memoryEnd = processMemoryMB();
    const double growth = memoryEnd - memoryAfterWarmup;

    std::printf ("soak: %.1f min of audio at %.0fx | %d song changes, %d jumps, %d loops, %d tempo, %d key, %d faders\n", minutes, speed, songChanges,
                 jumps, loops, tempoChanges, keyChanges, faderMoves);
    std::printf ("soak: test-thread stalls (busy computer, not counted against the engine): %d\n", harnessStalls);
    std::printf ("soak: underruns %llu, invalid samples %llu, peak %.3f (ceiling 0.944), memory %.1f -> %.1f MB (max %.1f, growth %+.1f MB)\n",
                 (unsigned long long) underrunsTotal, (unsigned long long) badSamples, peak, memoryAfterWarmup, memoryEnd, memoryMax, growth);

    const bool ok = underrunsTotal == 0 && badSamples == 0 && peak <= 0.95f && growth < 25.0;
    std::printf ("soak: %s\n", ok ? "OK" : "FAILED");
    return ok ? 0 : 1;
}
