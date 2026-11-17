// Developer tool: loads real audio files with the engine's loader and prints
// what the engine sees (format, gapless trim, levels, inter-track alignment,
// tempo, bar grid, sections). Usage:
//   liveplayer_inspect [--bpm 72] [--beats 4] <file1> <file2> ...
// Also: liveplayer_inspect --impulse <file>  (position of the first peak)

#include "Analysis.h"
#include "SongLoader.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace liveplayer;

static double dbfs (double v) { return v > 0 ? 20.0 * std::log10 (v) : -200.0; }

/** Onset envelope (10 ms hops) of one track, for alignment checks. */
static std::vector<float> envelope (const juce::AudioBuffer<float>& a, double sr)
{
    const int hop = (int) (sr / 100);
    std::vector<float> e ((size_t) (a.getNumSamples() / hop), 0.0f);
    float prev = 0.0f;
    for (size_t i = 0; i < e.size(); ++i)
    {
        float s = 0.0f;
        for (int c = 0; c < a.getNumChannels(); ++c)
            s += a.getRMSLevel (c, (int) i * hop, hop);
        e[i] = std::max (0.0f, s - prev);
        prev = s;
    }
    return e;
}

/** Best lag (ms) of b relative to a within +-200 ms, by cross-correlation of onsets. */
static double alignmentMs (const std::vector<float>& a, const std::vector<float>& b)
{
    double best = -1.0;
    int bestLag = 0;
    for (int lag = -20; lag <= 20; ++lag)
    {
        double s = 0.0;
        for (size_t i = 25; i + 25 < a.size() && i + 25 < b.size(); ++i)
            s += (double) a[i] * b[(size_t) ((int) i + lag)];
        if (s > best) { best = s; bestLag = lag; }
    }
    return bestLag * 10.0;
}

int main (int argc, char** argv)
{
    double bpm = 0.0;
    int beats = 4;
    std::vector<std::string> files;
    for (int i = 1; i < argc; ++i)
    {
        if (! std::strcmp (argv[i], "--bpm") && i + 1 < argc) bpm = std::atof (argv[++i]);
        else if (! std::strcmp (argv[i], "--beats") && i + 1 < argc) beats = std::atoi (argv[++i]);
        else if (! std::strcmp (argv[i], "--impulse") && i + 1 < argc)
        {
            juce::AudioFormatManager fm;
            fm.registerBasicFormats();
            std::unique_ptr<juce::AudioFormatReader> r (fm.createReaderFor (juce::File (juce::String::fromUTF8 (argv[++i]))));
            if (! r) { std::printf ("cannot read\n"); return 1; }
            juce::AudioBuffer<float> raw (1, (int) r->lengthInSamples);
            r->read (&raw, 0, raw.getNumSamples(), 0, true, false);
            int at = 0;
            for (int s = 0; s < raw.getNumSamples(); ++s)
                if (std::abs (raw.getSample (0, s)) > std::abs (raw.getSample (0, at))) at = s;
            const auto g = readMp3GaplessInfo (juce::File (juce::String::fromUTF8 (argv[i])));
            std::printf ("raw decoder output: %lld samples, peak at sample %d; LAME tag valid=%d delay=%d\n",
                         (long long) r->lengthInSamples, at, (int) g.valid, g.encoderDelay);
            return 0;
        }
        else files.push_back (argv[i]);
    }

    std::vector<TrackRequest> req;
    for (auto& f : files)
        req.push_back ({ f, juce::File (juce::String::fromUTF8 (f.c_str())).getFileNameWithoutExtension().toStdString() });
    SongLoader loader (req, 48000.0, 1);
    loader.startThread();
    while (loader.getPhase() == SongLoader::Phase::loading) juce::Thread::sleep (20);
    if (loader.getPhase() != SongLoader::Phase::ready) { std::printf ("load failed: %s\n", loader.getError().c_str()); return 1; }
    auto song = loader.getSong();

    std::printf ("%-14s %-5s %8s %4s %10s %9s %9s %8s\n", "track", "fmt", "srcRate", "ch", "length s", "peak dB", "rms dB", "align");
    const auto ref = envelope (song->tracks[0].audio, song->sampleRate);
    for (auto& t : song->tracks)
    {
        double peak = 0, rms = 0;
        for (int c = 0; c < t.audio.getNumChannels(); ++c)
        {
            peak = std::max (peak, (double) t.audio.getMagnitude (c, 0, t.audio.getNumSamples()));
            rms += std::pow (t.audio.getRMSLevel (c, 0, t.audio.getNumSamples()), 2.0);
        }
        rms = std::sqrt (rms / t.audio.getNumChannels());
        std::printf ("%-14s %-5s %8d %4d %10.3f %9.1f %9.1f %6.0fms\n", t.name.c_str(), t.format.c_str(), t.sourceSampleRate,
                     t.sourceChannels, t.audio.getNumSamples() / song->sampleRate, dbfs (peak), dbfs (rms),
                     alignmentMs (ref, envelope (t.audio, song->sampleRate)));
    }

    // Headroom of the instruments bus (all non-click/guide tracks summed).
    {
        juce::AudioBuffer<float> mix (2, (int) song->lengthSamples);
        mix.clear();
        for (auto& t : song->tracks)
        {
            if (isClickTrackName (t.name) || isGuideTrackName (t.name))
                continue;
            for (int c = 0; c < 2; ++c)
                mix.addFrom (c, 0, t.audio, juce::jmin (c, t.audio.getNumChannels() - 1), 0, t.audio.getNumSamples(),
                             t.audio.getNumChannels() == 1 ? 0.70710678f : 1.0f);
        }
        long long over = 0;
        double peak = 0.0;
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < mix.getNumSamples(); ++i)
            {
                const double v = std::abs (mix.getSample (c, i));
                peak = std::max (peak, v);
                over += v > 1.0;
            }
        std::printf ("\ninstruments bus: peak %.1f dBFS, %lld samples above 0 dBFS (%.3f %% of the song)\n", dbfs (peak), over,
                     100.0 * (double) over / (2.0 * mix.getNumSamples()));
    }

    auto input = analysis::prepareInput (*song, {});
    auto tempo = bpm > 0 ? analysis::alignTempo (input, bpm, beats) : analysis::detectTempo (input, beats);
    std::printf ("\ntempo: %.2f BPM (confidence %.2f, source %s), first beat %.3f s, first bar %.3f s, %d beats/bar\n",
                 tempo.bpm, tempo.confidence, tempo.source.c_str(), tempo.beatOffsetSec, tempo.downbeatOffsetSec, beats);
    for (auto& s : analysis::detectSections (input, tempo, beats))
        std::printf ("  %7.2f - %7.2f  %-12s (%s, %.2f)\n", s.startSec, s.endSec, s.label.c_str(), s.kind.c_str(), s.confidence);
    return 0;
}
