// Audio-quality, sync, performance and analysis tests for the engine
// internals. Uses the generated test songs (tools/generate-test-song.mjs).
// Usage: liveplayer_engine_audio_tests <test-audio-dir>

#include "Analysis.h"
#include "Limiter.h"
#include "Player.h"
#include "SongLoader.h"
#include "SongRenderer.h"

#include <CDSPResampler.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <map>
#include <tuple>
#include <string>
#include <vector>

using namespace liveplayer;

static int failures = 0;
#define CHECK(cond)                                                                   \
    do {                                                                              \
        if (! (cond)) {                                                               \
            std::fprintf (stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
            ++failures;                                                               \
        }                                                                             \
    } while (0)

static constexpr double engineRate = 48000.0;
static juce::File testDir;

// ---------------------------------------------------------------------------
static SongPtr loadSong (const std::vector<std::string>& names, const juce::File& dir, double rate = engineRate)
{
    std::vector<TrackRequest> req;
    for (auto& n : names)
        req.push_back ({ dir.getChildFile (n).getFullPathName().toStdString(), juce::File (n).getFileNameWithoutExtension().toStdString() });
    SongLoader loader (req, rate, 1);
    const auto t0 = std::chrono::steady_clock::now();
    loader.startThread();
    while (loader.getPhase() == SongLoader::Phase::loading)
        juce::Thread::sleep (20);
    const double secs = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
    if (loader.getPhase() != SongLoader::Phase::ready)
    {
        std::fprintf (stderr, "load failed: %s\n", loader.getError().c_str());
        return nullptr;
    }
    auto song = loader.getSong();
    std::printf ("  loaded %zu tracks (%.1f s of audio, %.0f MB) in %.2f s\n", song->tracks.size(), song->durationSec(),
                 song->memoryBytes() / 1048576.0, secs);
    return song;
}

/** A song made of in-memory buffers (no files). */
static SongPtr makeSong (std::vector<juce::AudioBuffer<float>> buffers)
{
    auto s = std::make_shared<SongData>();
    s->sampleRate = engineRate;
    for (size_t i = 0; i < buffers.size(); ++i)
    {
        TrackData t;
        t.name = "T" + std::to_string (i);
        t.audio = std::move (buffers[i]);
        s->lengthSamples = juce::jmax (s->lengthSamples, (juce::int64) t.audio.getNumSamples());
        s->tracks.push_back (std::move (t));
    }
    return s;
}

/** Renders `chunks` chunks; returns L channel of every track + metadata. */
struct Rendered
{
    std::vector<std::vector<float>> left; // per track
    std::vector<ChunkMeta> meta;
};

static Rendered renderChunks (SongRenderer& r, int numTracks, int chunks, double rate)
{
    Rendered out;
    out.left.resize ((size_t) numTracks);
    juce::AudioBuffer<float> buf (numTracks * 2, ChunkRing::chunkFrames);
    for (int k = 0; k < chunks; ++k)
    {
        ChunkMeta m;
        r.render (buf.getArrayOfWritePointers(), rate, m);
        out.meta.push_back (m);
        for (int t = 0; t < numTracks; ++t)
            out.left[(size_t) t].insert (out.left[(size_t) t].end(), buf.getReadPointer (t * 2), buf.getReadPointer (t * 2) + ChunkRing::chunkFrames);
    }
    return out;
}

static std::vector<int> findPulses (const std::vector<float>& x, float threshold, int minGap)
{
    std::vector<int> pos;
    for (int i = 1; i + 1 < (int) x.size(); ++i)
        if (std::abs (x[(size_t) i]) > threshold && std::abs (x[(size_t) i]) >= std::abs (x[(size_t) i - 1]) && std::abs (x[(size_t) i]) >= std::abs (x[(size_t) i + 1])
            && (pos.empty() || i - pos.back() > minGap))
            pos.push_back (i);
    return pos;
}

// ---------------------------------------------------------------------------
static void testResamplerQuality()
{
    std::printf ("[resampler] 1 kHz sine 44.1k -> 48k\n");
    const int n = 44100 * 2;
    std::vector<float> in ((size_t) n), out ((size_t) std::ceil (n * 48000.0 / 44100.0));
    for (int i = 0; i < n; ++i)
        in[(size_t) i] = 0.5f * (float) std::sin (2.0 * juce::MathConstants<double>::pi * 1000.0 * i / 44100.0);
    r8b::CDSPResampler24 rs (44100.0, 48000.0, 1 << 16);
    rs.oneshot (in.data(), n, out.data(), (int) out.size());

    double err = 0.0, sig = 0.0;
    for (size_t i = 4800; i < out.size() - 4800; ++i)
    {
        const double ideal = 0.5 * std::sin (2.0 * juce::MathConstants<double>::pi * 1000.0 * (double) i / 48000.0);
        err += std::pow (out[i] - ideal, 2.0);
        sig += ideal * ideal;
    }
    const double snr = 10.0 * std::log10 (sig / err);
    std::printf ("  SNR vs ideal sine: %.1f dB\n", snr);
    CHECK (snr > 100.0); // far below audibility (float audio ~ 140 dB)
}

static void testDirectPlaybackIsBitExact()
{
    std::printf ("[renderer] tempo 1.0 = untouched audio, sample-accurate seek\n");
    auto song = loadSong ({ "Tone.wav", "Pulse.wav" }, testDir.getChildFile ("short"));
    CHECK (song != nullptr);
    if (song == nullptr) return;
    CHECK (! song->tracks[0].resampled); // 48 kHz files at 48 kHz: no conversion

    SongRenderer r;
    r.prepare (song);
    r.seek (0.0, 1.0);
    auto out = renderChunks (r, 2, 100, 1.0);
    bool exact = true;
    const float* src = song->tracks[0].audio.getReadPointer (0);
    for (size_t i = 0; i < out.left[0].size(); ++i)
        exact &= out.left[0][i] == src[i] * 0.70710678f;
    CHECK (exact);
    CHECK (! r.isStretching());

    // Seek to an exact sample: the first frame must be that sample.
    const double target = 2.25 * engineRate + 17;
    r.seek (target, 1.0);
    out = renderChunks (r, 2, 2, 1.0);
    CHECK (out.left[0][0] == src[(size_t) target] * 0.70710678f);
    CHECK (out.meta[0].sourcePos == target);
}

static void testStretchSyncAndTiming()
{
    std::printf ("[renderer] time-stretch keeps tracks in sync and on time\n");
    auto pulseSong = loadSong ({ "Pulse.wav", "Pulse.wav", "Tone.wav" }, testDir.getChildFile ("short"));
    if (pulseSong == nullptr) { CHECK (false); return; }

    for (double rate : { 0.8, 1.25 })
    {
        SongRenderer r;
        r.prepare (pulseSong);
        r.seek (1.0 * engineRate, rate);
        auto out = renderChunks (r, 3, (int) (5.0 * engineRate / ChunkRing::chunkFrames), rate);
        CHECK (r.isStretching());

        // Two tracks with the same content must produce identical output.
        double maxDiff = 0.0;
        for (size_t i = 0; i < out.left[0].size(); ++i)
            maxDiff = std::max (maxDiff, (double) std::abs (out.left[0][i] - out.left[1][i]));
        std::printf ("  rate %.2f: max difference between identical tracks = %.2e\n", rate, maxDiff);
        CHECK (maxDiff < 1.0e-6);

        // Pulses every 0.5 s of song time => every 0.5/rate s of output, and
        // each must appear where the position metadata says it is.
        auto pulses = findPulses (out.left[0], 0.15f, (int) (0.2 * engineRate));
        double worstMs = 0.0;
        int matched = 0;
        for (int p : pulses)
        {
            const auto& m = out.meta[(size_t) p / ChunkRing::chunkFrames];
            const double songPos = m.sourcePos + (p % ChunkRing::chunkFrames) * m.rate; // samples
            const double nearest = std::round (songPos / (0.5 * engineRate)) * 0.5 * engineRate;
            worstMs = std::max (worstMs, std::abs (songPos - nearest) / engineRate * 1000.0);
            ++matched;
        }
        std::printf ("  rate %.2f: %d pulses, worst timing error %.2f ms\n", rate, matched, worstMs);
        CHECK (matched >= (int) (4.0 * rate * 2) - 2);
        CHECK (worstMs < 5.0);
    }
}

static double dominantFrequency (const std::vector<float>& x, size_t from, size_t to)
{
    int crossings = 0;
    for (size_t i = from + 1; i < to; ++i)
        if ((x[i - 1] < 0.0f) != (x[i] < 0.0f))
            ++crossings;
    return crossings / 2.0 / ((double) (to - from) / engineRate);
}

static double rmsDb (const std::vector<float>& x, size_t from, size_t to)
{
    double s = 0.0;
    for (size_t i = from; i < to; ++i) s += (double) x[i] * x[i];
    return 10.0 * std::log10 (s / (double) (to - from) + 1.0e-20);
}

static void testStretchQuality()
{
    std::printf ("[renderer] pitch and level preserved, click-free transitions\n");
    auto song = loadSong ({ "Tone.wav" }, testDir.getChildFile ("short"));
    if (song == nullptr) { CHECK (false); return; }
    const size_t chunk = ChunkRing::chunkFrames;

    SongRenderer r;
    r.prepare (song);
    r.seek (0.0, 1.0);
    // 1 s at 1.0, then change to 1.2 (glide + direct->stretch crossfade),
    // 2 s, back to 1.0 (stretch->direct crossfade), 1 s.
    auto a = renderChunks (r, 1, (int) (1.0 * engineRate / chunk), 1.0);
    auto b = renderChunks (r, 1, (int) (2.0 * engineRate / chunk), 1.2);
    CHECK (std::abs (r.currentRate() - 1.2) < 1.0e-9);
    auto c = renderChunks (r, 1, (int) (1.5 * engineRate / chunk), 1.0);
    CHECK (! r.isStretching());

    std::vector<float> all = a.left[0];
    all.insert (all.end(), b.left[0].begin(), b.left[0].end());
    all.insert (all.end(), c.left[0].begin(), c.left[0].end());

    // Largest sample-to-sample step: a 440 Hz sine at this level moves at
    // most ~0.0103 per sample; a click would be far larger.
    double maxStep = 0.0;
    for (size_t i = 1; i < all.size(); ++i)
        maxStep = std::max (maxStep, (double) std::abs (all[i] - all[i - 1]));
    std::printf ("  max sample step across both transitions: %.4f (sine limit 0.0103)\n", maxStep);
    CHECK (maxStep < 0.016);

    const auto& s = b.left[0];
    const double freq = dominantFrequency (s, (size_t) (0.6 * engineRate), s.size());
    const double levelIn = rmsDb (a.left[0], 0, a.left[0].size());
    const double levelStretched = rmsDb (s, (size_t) (0.6 * engineRate), s.size());
    std::printf ("  at 1.20x: frequency %.2f Hz (input 440), level %.2f dB vs %.2f dB\n", freq, levelStretched, levelIn);
    CHECK (std::abs (freq - 440.0) < 1.0);
    CHECK (std::abs (levelStretched - levelIn) < 1.0);
}

static void testRenderSpeed()
{
    std::printf ("[performance] render speed with time-stretch (this machine)\n");
    auto base = loadSong ({ "Drums.wav", "Bass.wav", "Keys.wav", "Lead.wav", "Click.wav" }, testDir.getChildFile ("song"));
    if (base == nullptr) { CHECK (false); return; }

    // 16 stems: a large worship multitrack (copies of the real stems).
    auto big = std::make_shared<SongData>();
    big->sampleRate = base->sampleRate;
    big->lengthSamples = base->lengthSamples;
    for (int i = 0; i < 16; ++i)
    {
        TrackData t = base->tracks[(size_t) i % base->tracks.size()];
        t.name += std::to_string (i);
        big->tracks.push_back (std::move (t));
    }
    int stereo = 0;
    for (auto& t : big->tracks) stereo += t.audio.getNumChannels() == 2;

    for (double rate : { 1.0, 0.9, 1.15 })
    {
        SongRenderer r;
        r.prepare (big);
        r.seek (20.0 * engineRate, rate);
        const int chunks = (int) (20.0 * engineRate / ChunkRing::chunkFrames);
        juce::AudioBuffer<float> buf ((int) big->tracks.size() * 2, ChunkRing::chunkFrames);
        const auto t0 = std::chrono::steady_clock::now();
        for (int k = 0; k < chunks; ++k)
        {
            ChunkMeta m;
            r.render (buf.getArrayOfWritePointers(), rate, m);
        }
        const double secs = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
        const double load = secs / 20.0;
        std::printf ("  16 stems (%d stereo) at %.2fx: %.1f%% of one core (%.1fx faster than real time)\n",
                     stereo, rate, load * 100.0, 1.0 / load);
        CHECK (load < (rate == 1.0 ? 0.05 : 0.75)); // must leave headroom on a 2-core laptop
    }
}

static void testAnalysis()
{
    std::printf ("[analysis] tempo and sections of the generated song\n");
    const auto manifestFile = testDir.getChildFile ("song/manifest.json");
    const auto manifest = juce::JSON::parse (manifestFile);
    const double trueBpm = manifest["bpm"];
    const double barSec = manifest["barSec"];

    auto song = loadSong ({ "Drums.wav", "Bass.wav", "Keys.wav", "Lead.wav", "Click.wav" }, testDir.getChildFile ("song"));
    if (song == nullptr) { CHECK (false); return; }

    auto t0 = std::chrono::steady_clock::now();
    const auto input = analysis::prepareInput (*song, {});
    const auto tempo = analysis::detectTempo (input);
    std::printf ("  with click: %.2f BPM (true %.0f), confidence %.2f, source %s, downbeat %.3f s\n",
                 tempo.bpm, trueBpm, tempo.confidence, tempo.source.c_str(), tempo.downbeatOffsetSec);
    CHECK (tempo.valid && std::abs (tempo.bpm - trueBpm) < 0.05);
    CHECK (tempo.source == "click");
    const double barPhase = std::fmod (tempo.downbeatOffsetSec + 1.0e-9, barSec);
    CHECK (barPhase < 0.03 || barSec - barPhase < 0.03);

    // Same song without the click track: tempo from the music itself.
    auto noClick = std::make_shared<SongData> (*song);
    noClick->tracks.pop_back();
    const auto inputNoClick = analysis::prepareInput (*noClick, {});
    const auto tempo2 = analysis::detectTempo (inputNoClick);
    std::printf ("  without click: %.2f BPM, confidence %.2f, downbeat %.3f s\n", tempo2.bpm, tempo2.confidence, tempo2.downbeatOffsetSec);
    CHECK (tempo2.valid && std::abs (tempo2.bpm - trueBpm) < 0.1);
    const double barPhase2 = std::fmod (tempo2.downbeatOffsetSec + 1.0e-9, barSec);
    CHECK (barPhase2 < 0.05 || barSec - barPhase2 < 0.05);

    const auto sections = analysis::detectSections (input, tempo);
    const double secs = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
    std::printf ("  analysis time: %.2f s\n", secs);
    std::printf ("  %-8s %-12s | detected\n", "true", "start");
    const auto* truth = manifest["sections"].getArray();
    int boundariesFound = 0, kindsCorrect = 0;
    for (const auto& t : *truth)
    {
        const double start = t["startSec"];
        const juce::String kind = t["kind"].toString();
        const analysis::Section* match = nullptr;
        for (const auto& s : sections)
            if (std::abs (s.startSec - start) < barSec * 0.6)
                match = &s;
        if (match != nullptr)
        {
            ++boundariesFound;
            if (match->kind == kind.toStdString())
                ++kindsCorrect;
        }
        std::printf ("  %-8s %6.1f s     | %s\n", kind.toRawUTF8(), start,
                     match ? (match->label + " (" + match->kind + ")").c_str() : "-- (no boundary)");
    }
    std::printf ("  detected %zu sections; boundaries %d/%d, kinds %d/%d\n", sections.size(), boundariesFound, truth->size(), kindsCorrect, truth->size());
    for (const auto& s : sections)
        std::printf ("    %6.1f - %6.1f  %s\n", s.startSec, s.endSec, s.label.c_str());
    CHECK (boundariesFound == truth->size());
    CHECK (kindsCorrect >= truth->size() - 1);
    CHECK (sections.size() <= (size_t) truth->size() + 1);
}

// ---------------------------------------------------------------------------
class FakeDevice final : public juce::AudioIODevice
{
public:
    explicit FakeDevice (int outputs = 2) : juce::AudioIODevice ("Fake", "Fake"), numOutputs (outputs) {}
    int numOutputs;
    juce::StringArray getOutputChannelNames() override { return { "1", "2", "3", "4" }; }
    juce::StringArray getInputChannelNames() override { return {}; }
    juce::Array<double> getAvailableSampleRates() override { return { engineRate }; }
    juce::Array<int> getAvailableBufferSizes() override { return { 480 }; }
    int getDefaultBufferSize() override { return 480; }
    juce::String open (const juce::BigInteger&, const juce::BigInteger&, double, int) override { return {}; }
    void close() override {}
    bool isOpen() override { return true; }
    void start (juce::AudioIODeviceCallback*) override {}
    void stop() override {}
    bool isPlaying() override { return true; }
    juce::String getLastError() override { return {}; }
    int getCurrentBufferSizeSamples() override { return 480; }
    double getCurrentSampleRate() override { return engineRate; }
    int getCurrentBitDepth() override { return 32; }
    juce::BigInteger getActiveOutputChannels() const override { juce::BigInteger b; b.setRange (0, numOutputs, true); return b; }
    juce::BigInteger getActiveInputChannels() const override { return 0; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }
};

struct FakeOutput
{
    Player& player;
    juce::AudioBuffer<float> block { 2, 480 };
    std::vector<float> left;

    /** Runs the callback in (roughly) real time so the render thread keeps up. */
    void run (double seconds)
    {
        const int blocks = (int) std::ceil (seconds * engineRate / 480);
        for (int b = 0; b < blocks; ++b)
        {
            player.audioDeviceIOCallbackWithContext (nullptr, 0, block.getArrayOfWritePointers(), 2, 480, {});
            left.insert (left.end(), block.getReadPointer (0), block.getReadPointer (0) + 480);
            juce::Thread::sleep (8);
        }
    }
};

static void testPlayerTransport()
{
    std::printf ("[player] play / pause / seek / stop / end with fades, no underruns\n");
    // A constant DC "track" makes fades easy to see.
    juce::AudioBuffer<float> dc (2, (int) (3.0 * engineRate));
    for (int c = 0; c < 2; ++c)
        juce::FloatVectorOperations::fill (dc.getWritePointer (c), 0.5f, dc.getNumSamples());
    auto song = makeSong ({ std::move (dc) });

    Player player;
    FakeDevice device;
    player.setSong (song);
    player.audioDeviceAboutToStart (&device);
    FakeOutput out { player };

    out.run (0.1);
    CHECK (out.left.back() == 0.0f); // stopped: silence

    player.play();
    out.run (0.3);
    const size_t playStart = 4800;
    float firstNonZero = 0.0f;
    size_t firstIdx = 0;
    for (size_t i = playStart; i < out.left.size(); ++i)
        if (out.left[i] != 0.0f) { firstNonZero = out.left[i]; firstIdx = i; break; }
    std::printf ("  fade-in starts at %.4f (smooth), steady level %.4f\n", firstNonZero, out.left.back());
    CHECK (firstNonZero > 0.0f && firstNonZero < 0.01f);
    CHECK (std::abs (out.left.back() - 0.5f) < 1.0e-6);
    // Fade-in completes within ~10 ms.
    CHECK (std::abs (out.left[firstIdx + (size_t) (0.012 * engineRate)] - 0.5f) < 1.0e-6);

    auto snap = player.snapshot();
    CHECK (snap.playState == 1);
    const double posBeforePause = snap.positionSec;
    CHECK (posBeforePause > 0.25 && posBeforePause < 0.35);

    player.pause();
    const size_t pauseIdx = out.left.size();
    out.run (0.1);
    size_t silentAt = 0;
    for (size_t i = pauseIdx; i < out.left.size(); ++i)
        if (out.left[i] == 0.0f) { silentAt = i; break; }
    std::printf ("  pause fade-out: %.1f ms\n", (double) (silentAt - pauseIdx) / engineRate * 1000.0);
    CHECK (silentAt > pauseIdx && silentAt - pauseIdx < (size_t) (0.015 * engineRate));
    snap = player.snapshot();
    CHECK (snap.playState == 2);
    const double pausedPos = snap.positionSec;
    out.run (0.1);
    CHECK (player.snapshot().positionSec == pausedPos); // position held while paused

    player.seek (2.0);
    out.run (0.05);
    CHECK (std::abs (player.snapshot().positionSec - 2.0) < 1.0e-9);
    player.play();
    out.run (0.5);
    snap = player.snapshot();
    std::printf ("  after seek to 2.0 s and 0.5 s of play: position %.3f s\n", snap.positionSec);
    CHECK (snap.positionSec > 2.4 && snap.positionSec < 2.56);

    out.run (0.8); // runs past the 3 s end
    snap = player.snapshot();
    CHECK (snap.ended && snap.playState == 0);
    CHECK (std::abs (snap.positionSec - 3.0) < 1.0e-6);
    CHECK (out.left.back() == 0.0f);

    player.play(); // play after the end restarts from 0
    out.run (0.2);
    snap = player.snapshot();
    CHECK (snap.playState == 1 && snap.positionSec < 0.25);

    player.stop();
    out.run (0.1);
    snap = player.snapshot();
    CHECK (snap.playState == 0 && snap.positionSec == 0.0);
    CHECK (out.left.back() == 0.0f);
    std::printf ("  underruns: %llu\n", (unsigned long long) snap.underruns);
    CHECK (snap.underruns == 0);

    // Tempo change while playing: stays continuous, no underruns.
    player.play();
    out.run (0.2);
    player.setTempoRatio (1.15);
    out.run (1.0); // the change glides (~120 ms time constant)
    snap = player.snapshot();
    std::printf ("  tempo change while playing: stretching=%d ratio=%.4f position=%.3f\n", (int) snap.stretching, snap.tempoRatio, snap.positionSec);
    CHECK (snap.stretching && std::abs (snap.tempoRatio - 1.15) < 1.0e-3);
    CHECK (snap.underruns == 0);
    player.audioDeviceStopped();
    player.setSong (nullptr);
}

static void testOutputRouting()
{
    std::printf ("[player] output buses: instruments vs click/cues\n");
    auto dc = [] (float v) {
        juce::AudioBuffer<float> b (2, (int) (4.0 * engineRate));
        for (int c = 0; c < 2; ++c)
            juce::FloatVectorOperations::fill (b.getWritePointer (c), v, b.getNumSamples());
        return b;
    };
    auto song = std::make_shared<SongData>();
    song->sampleRate = engineRate;
    for (auto [name, value, bus] : { std::tuple<const char*, float, int> { "Keys", 0.5f, busMain }, { "Click", 0.25f, busMonitor } })
    {
        TrackData t;
        t.name = name;
        t.audio = dc (value);
        t.bus = bus;
        song->lengthSamples = t.audio.getNumSamples();
        song->tracks.push_back (std::move (t));
    }

    Player player;
    FakeDevice device (4);
    player.setSong (song);
    player.audioDeviceAboutToStart (&device);
    juce::AudioBuffer<float> block (4, 480);
    auto run = [&] (double seconds) {
        for (int b = 0; b < (int) (seconds * engineRate / 480); ++b)
        {
            player.audioDeviceIOCallbackWithContext (nullptr, 0, block.getArrayOfWritePointers(), 4, 480, {});
            juce::Thread::sleep (8);
        }
    };
    auto last = [&] (int ch) { return block.getSample (ch, 479); };

    player.play();
    run (0.3);
    std::printf ("  stereo: out1 %.3f out2 %.3f out3 %.3f out4 %.3f\n", last (0), last (1), last (2), last (3));
    CHECK (std::abs (last (0) - 0.75f) < 1e-5f && std::abs (last (1) - 0.75f) < 1e-5f && last (2) == 0.0f);

    player.setOutputMode (1);
    run (0.05);
    std::printf ("  split:  out1 %.3f (instruments) out2 %.3f (click)\n", last (0), last (1));
    CHECK (std::abs (last (0) - 0.5f) < 1e-5f && std::abs (last (1) - 0.25f) < 1e-5f);

    player.setOutputMode (2);
    run (0.05);
    std::printf ("  4 ch:   out1/2 %.3f %.3f  out3/4 %.3f %.3f\n", last (0), last (1), last (2), last (3));
    CHECK (std::abs (last (0) - 0.5f) < 1e-5f && std::abs (last (1) - 0.5f) < 1e-5f);
    CHECK (std::abs (last (2) - 0.25f) < 1e-5f && std::abs (last (3) - 0.25f) < 1e-5f);

    // Meters: Keys at 0.5 on main, Click at 0.25 on monitor.
    {
        std::vector<float> m;
        player.takeMeters (m);
        std::printf ("  meters: keys %.3f click %.3f | main %.3f/%.3f monitor %.3f/%.3f\n", m[0], m[1], m[2], m[3], m[4], m[5]);
        CHECK (m.size() == 6 && std::abs (m[0] - 0.5f) < 1e-4f && std::abs (m[1] - 0.25f) < 1e-4f);
        CHECK (std::abs (m[2] - 0.5f) < 1e-3f && std::abs (m[4] - 0.25f) < 1e-3f);
        player.takeMeters (m);
        CHECK (m[0] == 0.0f); // reset after reading (no audio rendered in between)
    }

    // Monitor volume only affects the click bus.
    player.setMonitorGain (0.5f);
    run (0.2);
    CHECK (std::abs (last (0) - 0.5f) < 1e-5f && std::abs (last (2) - 0.125f) < 1e-5f);

    // Solo preview: muting a track ramps (no step) and silences only that track.
    player.setTrackGain (0, 0.0f);
    player.audioDeviceIOCallbackWithContext (nullptr, 0, block.getArrayOfWritePointers(), 4, 480, {});
    const float firstAfter = block.getSample (0, 0), mid = block.getSample (0, 240);
    std::printf ("  track gain 1 -> 0: first sample %.4f, after 5 ms %.4f\n", firstAfter, mid);
    CHECK (firstAfter > 0.49f && mid > 0.2f && mid < 0.3f);
    run (0.05);
    CHECK (last (0) == 0.0f && std::abs (last (2) - 0.125f) < 1e-5f);

    // Moving the click to the main bus takes effect immediately.
    player.setTrackBus (1, busMain);
    run (0.02);
    CHECK (std::abs (last (0) - 0.25f) < 1e-5f && last (2) == 0.0f);

    // A 2-output device ignores the 4-channel mode (falls back to stereo).
    FakeDevice stereo (2);
    player.audioDeviceStopped();
    player.audioDeviceAboutToStart (&stereo);
    CHECK (player.getOutputChannels() == 2);
    player.audioDeviceStopped();
    player.setSong (nullptr);
}

static void testLimiter()
{
    std::printf ("[limiter] safety limiter never exceeds -0.5 dBFS and is transparent below it\n");
    Limiter lim;
    lim.prepare (engineRate, 48);
    const int n = (int) engineRate * 2;
    std::vector<float> l ((size_t) n), r ((size_t) n), inL ((size_t) n);
    for (int i = 0; i < n; ++i)
    {
        // 220 Hz at -12 dBFS with +6 dBFS bursts (like summed, normalised stems).
        const double t = i / engineRate;
        const float amp = (std::fmod (t, 0.25) < 0.02) ? 2.0f : 0.25f;
        l[(size_t) i] = r[(size_t) i] = inL[(size_t) i] = amp * (float) std::sin (2.0 * juce::MathConstants<double>::pi * 220.0 * t);
    }
    for (int i = 0; i < n; i += 256)
        lim.process (l.data() + i, r.data() + i, std::min (256, n - i));
    float maxOut = 0.0f, maxStep = 0.0f;
    for (int i = 1; i < n; ++i)
    {
        maxOut = std::max (maxOut, std::abs (l[(size_t) i]));
        maxStep = std::max (maxStep, std::abs (l[(size_t) i] - l[(size_t) i - 1]));
    }
    std::printf ("  +6 dBFS bursts: output peak %.2f dBFS (ceiling -0.50)\n", 20.0 * std::log10 (maxOut));
    CHECK (maxOut <= 0.9441f);

    // Quiet material passes untouched (only delayed by latency()).
    Limiter clean;
    clean.prepare (engineRate, 48);
    std::vector<float> a ((size_t) n), b ((size_t) n), src ((size_t) n);
    for (int i = 0; i < n; ++i)
        a[(size_t) i] = b[(size_t) i] = src[(size_t) i] = 0.5f * (float) std::sin (0.01 * i);
    clean.process (a.data(), b.data(), n);
    bool exact = true;
    for (int i = clean.latency(); i < n; ++i)
        exact &= a[(size_t) i] == src[(size_t) (i - clean.latency())];
    CHECK (exact);
    CHECK (clean.takeMinGain() == 1.0f);
}

static void testMp3GaplessParser()
{
    std::printf ("[mp3] LAME gapless tag parsing\n");
    // ID3v2 (10 bytes, empty) + MPEG1 Layer III stereo frame with Info + LAME tag.
    std::vector<juce::uint8> bytes = { 'I', 'D', '3', 3, 0, 0, 0, 0, 0, 0 };
    std::vector<juce::uint8> frame (417, 0);
    frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00; // 128 kbps, 44.1 kHz, stereo
    const size_t x = 4 + 32;
    std::memcpy (&frame[x], "Info", 4);
    frame[x + 7] = 0x01 | 0x04;                    // frames + TOC
    frame[x + 8 + 2] = 0x12; frame[x + 8 + 3] = 0x34; // 0x1234 frames
    const size_t lame = x + 8 + 4 + 100;
    std::memcpy (&frame[lame], "LAME3.100", 9);
    // delay 576 (0x240), padding 1000 (0x3E8) -> 24 0 3E 8 -> bytes 0x24 0x03 0xE8
    frame[lame + 21] = 0x24; frame[lame + 22] = 0x03; frame[lame + 23] = 0xe8;
    bytes.insert (bytes.end(), frame.begin(), frame.end());

    const auto file = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("liveplayer_gapless_test.mp3");
    file.replaceWithData (bytes.data(), bytes.size());
    const auto info = readMp3GaplessInfo (file);
    file.deleteFile();
    std::printf ("  delay %d, padding %d, frames %lld\n", info.encoderDelay, info.encoderPadding, (long long) info.frames);
    CHECK (info.valid && info.encoderDelay == 576 && info.encoderPadding == 1000 && info.frames == 0x1234);
}

static void testTrackRoles()
{
    CHECK (isClickTrackName ("Click"));
    CHECK (isClickTrackName ("01 CLICK track"));
    CHECK (isClickTrackName ("Metr\xc3\xb3nomo"));
    CHECK (isGuideTrackName ("Guide"));
    CHECK (isGuideTrackName ("Gu\xc3\xad" "a voces"));
    CHECK (isGuideTrackName ("Cues"));
    CHECK (! isGuideTrackName ("Cuerdas"));
    CHECK (! isClickTrackName ("Keys"));
}

int main (int argc, char** argv)
{
    if (argc < 2)
    {
        std::fprintf (stderr, "usage: %s <test-audio-dir>\n", argv[0]);
        return 2;
    }
    testDir = juce::File (juce::String::fromUTF8 (argv[1]));
    if (! testDir.getChildFile ("song/manifest.json").existsAsFile())
    {
        std::fprintf (stderr, "missing test audio; run: node tools/generate-test-song.mjs %s\n", argv[1]);
        return 2;
    }

    testTrackRoles();
    testMp3GaplessParser();
    testResamplerQuality();
    testDirectPlaybackIsBitExact();
    testStretchSyncAndTiming();
    testStretchQuality();
    testPlayerTransport();
    testOutputRouting();
    testLimiter();
    testRenderSpeed();
    testAnalysis();

    if (failures == 0)
        std::printf ("engine audio tests: OK\n");
    else
        std::printf ("engine audio tests: %d failure(s)\n", failures);
    return failures == 0 ? 0 : 1;
}
