// Offline music analysis: tempo / beat grid and song-section detection.
//
// Everything here runs on a background thread after a song is loaded. The
// algorithms are classic MIR techniques (no machine-learning model, no
// external service):
//  - tempo: spectral-flux onset envelope -> autocorrelation with a tempo
//    prior -> whole-song comb alignment for a precise BPM and beat phase;
//  - sections: bar-synchronous chroma + timbre (MFCC) features -> self-
//    similarity matrix -> checkerboard novelty for boundaries -> clustering
//    of repeated segments -> naming rules (chorus = loudest repeated part...).
// Results are suggestions: the user can always correct them.

#include "Analysis.h"

#include <juce_dsp/juce_dsp.h>

#include <CDSPResampler.h>

#include <algorithm>
#include <cstdio>
#include <cmath>
#include <map>
#include <numeric>

namespace liveplayer::analysis
{

namespace
{
constexpr double analysisRate = 22050.0;
constexpr int featureOrder = 11; // 2048-point FFT: harmony / timbre
constexpr int onsetOrder = 9;    // 512-point FFT: sharp onsets for beat timing
constexpr int hopSize = 256; // 11.6 ms
constexpr int numMel = 24;
constexpr int numMfcc = 12;

std::vector<float> resampleMono (const std::vector<float>& in, double fromRate)
{
    if (in.empty())
        return {};
    if (std::abs (fromRate - analysisRate) < 0.5)
        return in;
    const auto outLength = (int) std::ceil ((double) in.size() * analysisRate / fromRate);
    std::vector<float> out ((size_t) outLength);
    r8b::CDSPResampler16 resampler (fromRate, analysisRate, 1 << 16);
    resampler.oneshot (in.data(), (int) in.size(), out.data(), outLength);
    return out;
}

/** Per-STFT-frame features. */
struct Frames
{
    double frameRate = analysisRate / hopSize;
    double timeOffsetSec = 0.0; // time of frame 0 (centre of its window)
    double frameAt (double sec) const { return (sec - timeOffsetSec) * frameRate; }
    std::vector<float> flux;    // broadband spectral flux (onsets)
    std::vector<float> lowFlux; // < 150 Hz (kick / bass onsets)
    std::vector<float> rms;
    std::vector<std::array<float, 12>> chroma;
    std::vector<std::array<float, numMfcc>> mfcc;
    size_t size() const { return flux.size(); }
};

Frames computeFrames (const std::vector<float>& x, int order = featureOrder)
{
    Frames f;
    const int fftSize = 1 << order;
    f.timeOffsetSec = (fftSize / 2) / analysisRate;
    if (x.size() < (size_t) fftSize)
        return f;

    juce::dsp::FFT fft (order);
    std::vector<float> window ((size_t) fftSize), buffer ((size_t) fftSize * 2);
    for (int i = 0; i < fftSize; ++i)
        window[(size_t) i] = 0.5f - 0.5f * std::cos (2.0f * juce::MathConstants<float>::pi * (float) i / (float) fftSize);

    const int bins = fftSize / 2 + 1;
    const double binHz = analysisRate / fftSize;

    // Pitch class of every bin (100 Hz .. 3 kHz), -1 if outside.
    std::vector<int> pitchClass ((size_t) bins, -1);
    for (int k = 1; k < bins; ++k)
    {
        const double hz = k * binHz;
        if (hz >= 100.0 && hz <= 3000.0)
        {
            const int midi = (int) std::lround (69.0 + 12.0 * std::log2 (hz / 440.0));
            pitchClass[(size_t) k] = ((midi % 12) + 12) % 12;
        }
    }

    // Triangular mel filterbank, 60 Hz .. 8 kHz.
    auto hzToMel = [] (double hz) { return 2595.0 * std::log10 (1.0 + hz / 700.0); };
    auto melToHz = [] (double mel) { return 700.0 * (std::pow (10.0, mel / 2595.0) - 1.0); };
    std::vector<double> edges (numMel + 2);
    for (int i = 0; i < numMel + 2; ++i)
        edges[(size_t) i] = melToHz (hzToMel (60.0) + (hzToMel (8000.0) - hzToMel (60.0)) * i / (numMel + 1));
    std::vector<std::vector<std::pair<int, float>>> melWeights (numMel);
    for (int m = 0; m < numMel; ++m)
        for (int k = 1; k < bins; ++k)
        {
            const double hz = k * binHz;
            const double lo = edges[(size_t) m], mid = edges[(size_t) m + 1], hi = edges[(size_t) m + 2];
            double w = 0.0;
            if (hz > lo && hz <= mid) w = (hz - lo) / (mid - lo);
            else if (hz > mid && hz < hi) w = (hi - hz) / (hi - mid);
            if (w > 0.0)
                melWeights[(size_t) m].push_back ({ k, (float) w });
        }

    const int lowBin = (int) std::ceil (150.0 / binHz);
    const size_t numFrames = (x.size() - (size_t) fftSize) / hopSize + 1;
    f.flux.resize (numFrames);
    f.lowFlux.resize (numFrames);
    f.rms.resize (numFrames);
    f.chroma.resize (numFrames);
    f.mfcc.resize (numFrames);

    std::vector<float> prevLog ((size_t) bins, 0.0f), logMag ((size_t) bins);
    std::array<double, numMel> melLog {};

    for (size_t t = 0; t < numFrames; ++t)
    {
        const float* src = x.data() + t * hopSize;
        double energy = 0.0;
        for (int i = 0; i < fftSize; ++i)
        {
            buffer[(size_t) i] = src[i] * window[(size_t) i];
            energy += (double) src[i] * src[i];
        }
        std::fill (buffer.begin() + fftSize, buffer.end(), 0.0f);
        fft.performFrequencyOnlyForwardTransform (buffer.data(), true);

        float flux = 0.0f, low = 0.0f;
        std::array<float, 12> chroma {};
        for (int k = 1; k < bins; ++k)
        {
            const float mag = buffer[(size_t) k] / (float) fftSize;
            logMag[(size_t) k] = std::log1p (1000.0f * mag);
            const float diff = logMag[(size_t) k] - prevLog[(size_t) k];
            if (diff > 0.0f)
            {
                flux += diff;
                if (k < lowBin)
                    low += diff;
            }
            if (pitchClass[(size_t) k] >= 0)
                chroma[(size_t) pitchClass[(size_t) k]] += mag * mag;
        }
        std::swap (prevLog, logMag);

        float norm = 0.0f;
        for (auto& c : chroma) { c = std::sqrt (c); norm += c * c; }
        norm = std::sqrt (norm);
        if (norm > 1.0e-9f)
            for (auto& c : chroma) c /= norm;

        for (int m = 0; m < numMel; ++m)
        {
            double e = 0.0;
            for (auto [k, w] : melWeights[(size_t) m])
            {
                const double mag = buffer[(size_t) k] / (double) fftSize;
                e += w * mag * mag;
            }
            melLog[(size_t) m] = std::log10 (e + 1.0e-10);
        }
        std::array<float, numMfcc> mfcc {};
        for (int c = 1; c <= numMfcc; ++c)
        {
            double s = 0.0;
            for (int m = 0; m < numMel; ++m)
                s += melLog[(size_t) m] * std::cos (juce::MathConstants<double>::pi * c * (m + 0.5) / numMel);
            mfcc[(size_t) c - 1] = (float) s;
        }

        f.flux[t] = t == 0 ? 0.0f : flux;
        f.lowFlux[t] = t == 0 ? 0.0f : low;
        f.rms[t] = (float) std::sqrt (energy / fftSize);
        f.chroma[t] = chroma;
        f.mfcc[t] = mfcc;
    }
    return f;
}

/** Onset envelope: local-mean removed, half-wave rectified, unit variance. */
std::vector<float> onsetEnvelope (const std::vector<float>& flux, double frameRate)
{
    const size_t n = flux.size();
    std::vector<float> out (n, 0.0f);
    if (n == 0)
        return out;
    const int half = (int) std::lround (0.25 * frameRate);
    std::vector<double> prefix (n + 1, 0.0);
    for (size_t i = 0; i < n; ++i)
        prefix[i + 1] = prefix[i] + flux[i];
    double sumSq = 0.0;
    for (size_t i = 0; i < n; ++i)
    {
        const size_t a = (size_t) std::max<long long> (0, (long long) i - half);
        const size_t b = std::min (n, i + (size_t) half + 1);
        const double mean = (prefix[b] - prefix[a]) / (double) (b - a);
        out[i] = (float) std::max (0.0, flux[i] - mean);
        sumSq += (double) out[i] * out[i];
    }
    const double sd = std::sqrt (sumSq / (double) n);
    if (sd > 1.0e-9)
        for (auto& v : out) v = (float) (v / sd);
    return out;
}

float sampleAt (const std::vector<float>& v, double pos)
{
    if (pos < 0.0)
        return 0.0f;
    const auto i = (size_t) pos;
    if (i + 1 >= v.size())
        return 0.0f;
    const float frac = (float) (pos - (double) i);
    return v[i] * (1.0f - frac) + v[i + 1] * frac;
}

struct CombScore
{
    double score = 0.0;
    double phase = 0.0; // frames
    double meanOverPhases = 0.0;
};

/** Mean onset strength on a beat grid of `period` frames, best phase. */
CombScore combAlign (const std::vector<float>& env, double period)
{
    CombScore best;
    constexpr int phaseSteps = 48;
    double total = 0.0;
    for (int p = 0; p < phaseSteps; ++p)
    {
        const double phase = period * p / phaseSteps;
        double sum = 0.0;
        int count = 0;
        for (double pos = phase; pos < (double) env.size() - 1; pos += period)
        {
            sum += sampleAt (env, pos);
            ++count;
        }
        const double s = count > 0 ? sum / count : 0.0;
        total += s;
        if (s > best.score)
        {
            best.score = s;
            best.phase = phase;
        }
    }
    best.meanOverPhases = total / phaseSteps;
    return best;
}

Tempo tempoFromEnvelope (const std::vector<float>& env, double frameRate, double timeOffsetSec)
{
    Tempo tempo;
    const size_t n = env.size();
    const int lagMin = (int) std::floor (frameRate * 60.0 / 200.0);
    const int lagMax = (int) std::ceil (frameRate * 60.0 / 50.0);
    if (n < (size_t) (lagMax * 8))
        return tempo;

    std::vector<double> acf ((size_t) lagMax * 4 + 2, 0.0);
    for (size_t lag = 1; lag < acf.size() && lag < n; ++lag)
    {
        double s = 0.0;
        for (size_t i = 0; i + lag < n; ++i)
            s += (double) env[i] * env[i + lag];
        acf[lag] = s / (double) (n - lag);
    }

    // Harmonic-enhanced autocorrelation weighted by a tempo prior centred
    // near 110 BPM (resolves most double/half-tempo ambiguities).
    auto prior = [] (double bpm) { const double z = std::log2 (bpm / 110.0) / 0.9; return std::exp (-0.5 * z * z); };
    double bestScore = -1.0;
    int bestLag = lagMin;
    for (int lag = lagMin; lag <= lagMax; ++lag)
    {
        const double s = (acf[(size_t) lag] + 0.5 * acf[(size_t) lag * 2] + 0.25 * acf[(size_t) lag * 4]) * prior (60.0 * frameRate / lag);
        if (s > bestScore)
        {
            bestScore = s;
            bestLag = lag;
        }
    }

    // Parabolic refinement of the peak.
    double lag = bestLag;
    if (bestLag > 1 && bestLag + 1 < (int) acf.size())
    {
        const double a = acf[(size_t) bestLag - 1], b = acf[(size_t) bestLag], c = acf[(size_t) bestLag + 1];
        const double denom = a - 2.0 * b + c;
        if (std::abs (denom) > 1.0e-12)
            lag += juce::jlimit (-0.5, 0.5, 0.5 * (a - c) / denom);
    }
    const double coarseBpm = 60.0 * frameRate / lag;

    // Fine search: the BPM whose beat grid lines up best with the onsets over
    // the WHOLE song (0.01 BPM steps), so the grid does not drift.
    double bestBpm = coarseBpm;
    CombScore best;
    for (double bpm = coarseBpm * 0.97; bpm <= coarseBpm * 1.03; bpm += 0.01)
    {
        const auto s = combAlign (env, 60.0 * frameRate / bpm);
        if (s.score > best.score)
        {
            best = s;
            bestBpm = bpm;
        }
    }

    // Songs made in a DAW almost always use an integer tempo.
    const double rounded = std::round (bestBpm);
    if (std::abs (rounded - bestBpm) < 0.06)
    {
        const auto s = combAlign (env, 60.0 * frameRate / rounded);
        if (s.score >= best.score * 0.985)
        {
            best = s;
            bestBpm = rounded;
        }
    }

    tempo.valid = true;
    tempo.bpm = bestBpm;
    tempo.beatOffsetSec = best.phase / frameRate + timeOffsetSec;
    const double beatSec = 60.0 / bestBpm;
    while (tempo.beatOffsetSec >= beatSec) tempo.beatOffsetSec -= beatSec;
    tempo.confidence = best.score > 0.0 ? juce::jlimit (0.0, 1.0, (best.score - best.meanOverPhases) / best.score * 1.5) : 0.0;
    return tempo;
}

/** Picks which of the 4 beats is the bar's first one (4/4 assumed). */
double chooseDownbeat (const Tempo& tempo, const Frames& onsets, const std::vector<float>& lowEnv,
                       const Frames& features, const std::vector<float>& clickEnv, const Frames* clickFrames)
{
    const double beatSec = 60.0 / tempo.bpm;
    const double durationSec = (double) onsets.size() / onsets.frameRate;
    std::array<double, 4> score {};
    std::array<int, 4> count {};

    auto chromaAt = [&] (double sec) -> const std::array<float, 12>* {
        const auto i = (long long) std::llround (features.frameAt (sec));
        return (i >= 0 && i < (long long) features.size()) ? &features.chroma[(size_t) i] : nullptr;
    };

    int beat = 0;
    for (double t = tempo.beatOffsetSec; t < durationSec - beatSec; t += beatSec, ++beat)
    {
        const int phase = beat % 4;
        double s = 0.0;
        if (! clickEnv.empty() && clickFrames != nullptr)
            s += 2.0 * sampleAt (clickEnv, clickFrames->frameAt (t)); // accented click on beat 1
        s += sampleAt (lowEnv, onsets.frameAt (t));                     // kick drum
        // Harmonic change: chords tend to change on the bar line.
        const auto* after = chromaAt (t + 0.5 * beatSec);
        const auto* before = chromaAt (t - 0.5 * beatSec);
        if (after != nullptr && before != nullptr)
        {
            double dot = 0.0;
            for (int c = 0; c < 12; ++c)
                dot += (*after)[(size_t) c] * (*before)[(size_t) c];
            s += 3.0 * (1.0 - dot);
        }
        score[(size_t) phase] += s;
        ++count[(size_t) phase];
    }

    int bestPhase = 0;
    for (int p = 1; p < 4; ++p)
        if (count[(size_t) p] > 0 && score[(size_t) p] / count[(size_t) p] > score[(size_t) bestPhase] / juce::jmax (1, count[(size_t) bestPhase]))
            bestPhase = p;
    return tempo.beatOffsetSec + bestPhase * beatSec;
}

// ---- Sections ---------------------------------------------------------------

struct Bar
{
    double startSec = 0.0;
    std::array<float, 12> chroma {};
    std::array<float, numMfcc> mfcc {};
    double energyDb = -100.0;
};

double cosine (const std::array<float, 12>& a, const std::array<float, 12>& b)
{
    double d = 0.0, na = 0.0, nb = 0.0;
    for (int i = 0; i < 12; ++i)
    {
        d += a[(size_t) i] * b[(size_t) i];
        na += a[(size_t) i] * a[(size_t) i];
        nb += b[(size_t) i] * b[(size_t) i];
    }
    return (na > 0.0 && nb > 0.0) ? d / std::sqrt (na * nb) : 0.0;
}

std::vector<Bar> makeBars (const Frames& frames, double durationSec, double barSec, double firstBarSec)
{
    std::vector<double> starts;
    // Pickup before the first bar line belongs to the first bar.
    // Walk back to the first bar line; a pickup shorter than 1/4 bar is
    // folded into the first bar instead of becoming its own tiny bar.
    double t = firstBarSec;
    while (t > 0.25 * barSec) t -= barSec;
    for (; t < durationSec - barSec * 0.25; t += barSec)
        starts.push_back (std::max (0.0, t));
    if (starts.empty())
        return {};
    starts[0] = 0.0;

    std::vector<Bar> bars (starts.size());
    for (size_t b = 0; b < starts.size(); ++b)
    {
        const double endSec = b + 1 < starts.size() ? starts[b + 1] : durationSec;
        const auto f0 = (size_t) std::max (0.0, frames.frameAt (starts[b]));
        const auto f1 = std::min (frames.size(), (size_t) std::max (0.0, frames.frameAt (endSec)));
        Bar bar;
        bar.startSec = starts[b];
        double energy = 0.0;
        size_t n = 0;
        for (size_t f = f0; f < f1; ++f, ++n)
        {
            for (int c = 0; c < 12; ++c) bar.chroma[(size_t) c] += frames.chroma[f][(size_t) c];
            for (int c = 0; c < numMfcc; ++c) bar.mfcc[(size_t) c] += frames.mfcc[f][(size_t) c];
            energy += (double) frames.rms[f] * frames.rms[f];
        }
        if (n > 0)
        {
            for (auto& v : bar.mfcc) v /= (float) n;
            bar.energyDb = 10.0 * std::log10 (energy / (double) n + 1.0e-12);
        }
        bars[b] = bar;
    }
    return bars;
}

/** Self-similarity of bars, z-normalised (mean 0, std 1 off the diagonal). */
std::vector<std::vector<double>> similarityMatrix (std::vector<Bar>& bars)
{
    const size_t n = bars.size();
    // Standardise MFCCs across the song.
    for (int c = 0; c < numMfcc; ++c)
    {
        double mean = 0.0, sq = 0.0;
        for (auto& b : bars) mean += b.mfcc[(size_t) c];
        mean /= (double) n;
        for (auto& b : bars) sq += std::pow (b.mfcc[(size_t) c] - mean, 2.0);
        const double sd = std::sqrt (sq / (double) n) + 1.0e-9;
        for (auto& b : bars) b.mfcc[(size_t) c] = (float) ((b.mfcc[(size_t) c] - mean) / sd);
    }

    std::vector<std::vector<double>> dist (n, std::vector<double> (n, 0.0));
    std::vector<double> all;
    for (size_t i = 0; i < n; ++i)
        for (size_t j = i + 1; j < n; ++j)
        {
            double d = 0.0;
            for (int c = 0; c < numMfcc; ++c) d += std::pow (bars[i].mfcc[(size_t) c] - bars[j].mfcc[(size_t) c], 2.0);
            dist[i][j] = dist[j][i] = std::sqrt (d);
            all.push_back (dist[i][j]);
        }
    double sigma = 1.0;
    if (! all.empty())
    {
        std::nth_element (all.begin(), all.begin() + (long) all.size() / 2, all.end());
        sigma = std::max (1.0e-6, all[all.size() / 2]);
    }

    std::vector<std::vector<double>> s (n, std::vector<double> (n, 0.0));
    for (size_t i = 0; i < n; ++i)
        for (size_t j = 0; j < n; ++j)
        {
            const double timbre = std::exp (-0.5 * std::pow (dist[i][j] / sigma, 2.0));
            const double harmony = cosine (bars[i].chroma, bars[j].chroma);
            const double energy = std::exp (-std::abs (bars[i].energyDb - bars[j].energyDb) / 6.0);
            s[i][j] = 0.4 * harmony + 0.4 * timbre + 0.2 * energy;
        }

    double mean = 0.0, sq = 0.0;
    size_t count = 0;
    for (size_t i = 0; i < n; ++i)
        for (size_t j = 0; j < n; ++j)
            if (i != j) { mean += s[i][j]; ++count; }
    mean /= (double) std::max<size_t> (1, count);
    for (size_t i = 0; i < n; ++i)
        for (size_t j = 0; j < n; ++j)
            if (i != j) sq += std::pow (s[i][j] - mean, 2.0);
    const double sd = std::sqrt (sq / (double) std::max<size_t> (1, count)) + 1.0e-9;
    for (auto& row : s)
        for (auto& v : row)
            v = (v - mean) / sd;
    return s;
}

std::vector<double> noveltyCurve (const std::vector<std::vector<double>>& s, const std::vector<Bar>& bars)
{
    const int n = (int) s.size();
    constexpr int w = 4; // bars on each side
    std::vector<double> nov ((size_t) n, 0.0);
    for (int i = 1; i < n; ++i)
    {
        double v = 0.0, wsum = 0.0;
        for (int a = -w; a < w; ++a)
            for (int b = -w; b < w; ++b)
            {
                const int x = i + a, y = i + b;
                if (x < 0 || y < 0 || x >= n || y >= n)
                    continue;
                const double sign = ((a < 0) == (b < 0)) ? 1.0 : -1.0;
                const double taper = std::exp (-0.5 * (std::pow ((a + 0.5) / (w * 0.6), 2.0) + std::pow ((b + 0.5) / (w * 0.6), 2.0)));
                v += sign * taper * s[(size_t) x][(size_t) y];
                wsum += taper;
            }
        nov[(size_t) i] = wsum > 0.0 ? v / wsum : 0.0;
        // Sudden loudness change (e.g. the band drops out) also marks a boundary.
        double before = 0.0, after = 0.0;
        int nb = 0, na = 0;
        for (int k = 1; k <= 2; ++k)
        {
            if (i - k >= 0) { before += bars[(size_t) (i - k)].energyDb; ++nb; }
            if (i + k - 1 < n) { after += bars[(size_t) (i + k - 1)].energyDb; ++na; }
        }
        if (nb > 0 && na > 0)
            nov[(size_t) i] += 0.08 * std::abs (after / na - before / nb);
    }
    return nov;
}

std::vector<int> pickBoundaries (const std::vector<double>& nov)
{
    const int n = (int) nov.size();
    std::vector<int> result { 0 };
    if (n < 6)
        return result;

    double mean = 0.0, sq = 0.0;
    for (double v : nov) mean += v;
    mean /= n;
    for (double v : nov) sq += (v - mean) * (v - mean);
    const double sd = std::sqrt (sq / n);

    // Phrase grid: most sections start every 4 bars from some reference.
    std::array<double, 4> phaseScore {};
    for (int i = 1; i < n; ++i) phaseScore[(size_t) (i % 4)] += std::max (0.0, nov[(size_t) i] - mean);
    const int phrasePhase = (int) (std::max_element (phaseScore.begin(), phaseScore.end()) - phaseScore.begin());

    std::vector<std::pair<double, int>> candidates;
    for (int i = 2; i <= n - 2; ++i)
    {
        bool isPeak = true;
        for (int k = -2; k <= 2 && isPeak; ++k)
            if (k != 0 && i + k >= 0 && i + k < n && nov[(size_t) (i + k)] > nov[(size_t) i])
                isPeak = false;
        double score = nov[(size_t) i];
        if (i % 4 == phrasePhase)
            score += 0.35 * sd;
        if (isPeak && score > mean + 0.4 * sd)
            candidates.push_back ({ score, i });
    }
    std::sort (candidates.rbegin(), candidates.rend());

    for (auto [score, i] : candidates)
    {
        bool farEnough = true;
        for (int b : result)
            if (std::abs (b - i) < 4)
                farEnough = false;
        if (farEnough && n - i >= 2)
            result.push_back (i);
    }
    std::sort (result.begin(), result.end());
    return result;
}

struct Segment
{
    int start = 0, length = 0;
    int cluster = -1;
    double energyDb = 0.0;
    std::string kind, label;
    double confidence = 0.5;
};

double segmentSimilarity (const std::vector<std::vector<double>>& s, const Segment& a, const Segment& b)
{
    const int len = std::min (a.length, b.length);
    if (len <= 0)
        return -10.0;
    auto diag = [&] (int a0, int b0) {
        double sum = 0.0;
        for (int k = 0; k < len; ++k)
            sum += s[(size_t) (a0 + k)][(size_t) (b0 + k)];
        return sum / len;
    };
    double sim = std::max (diag (a.start, b.start), diag (a.start + a.length - len, b.start + b.length - len));
    const double ratio = (double) std::max (a.length, b.length) / len;
    if (ratio > 2.0)
        sim -= 0.5 * (ratio - 2.0);
    return sim;
}

void clusterSegments (std::vector<Segment>& segs, const std::vector<std::vector<double>>& s)
{
    const size_t n = segs.size();
    std::vector<std::vector<size_t>> clusters;
    for (size_t i = 0; i < n; ++i)
        clusters.push_back ({ i });

    std::vector<std::vector<double>> sim (n, std::vector<double> (n, 0.0));
    for (size_t i = 0; i < n; ++i)
        for (size_t j = i + 1; j < n; ++j)
            sim[i][j] = sim[j][i] = segmentSimilarity (s, segs[i], segs[j]);

    constexpr double threshold = 0.9; // in standard deviations above the song's average similarity
    while (clusters.size() > 1)
    {
        double best = -1.0e9;
        size_t bi = 0, bj = 0;
        for (size_t i = 0; i < clusters.size(); ++i)
            for (size_t j = i + 1; j < clusters.size(); ++j)
            {
                double sum = 0.0;
                for (auto a : clusters[i])
                    for (auto b : clusters[j])
                        sum += sim[a][b];
                const double avg = sum / (double) (clusters[i].size() * clusters[j].size());
                if (avg > best) { best = avg; bi = i; bj = j; }
            }
        if (best < threshold)
            break;
        clusters[bi].insert (clusters[bi].end(), clusters[bj].begin(), clusters[bj].end());
        clusters.erase (clusters.begin() + (long) bj);
    }

    // Number clusters in order of first appearance.
    std::sort (clusters.begin(), clusters.end(), [] (auto& a, auto& b) { return *std::min_element (a.begin(), a.end()) < *std::min_element (b.begin(), b.end()); });
    for (size_t c = 0; c < clusters.size(); ++c)
        for (auto i : clusters[c])
            segs[i].cluster = (int) c;
}

void nameSegments (std::vector<Segment>& segs)
{
    const int n = (int) segs.size();
    std::map<int, std::vector<int>> members;
    for (int i = 0; i < n; ++i)
        members[segs[(size_t) i].cluster].push_back (i);

    std::vector<double> energies;
    for (auto& s : segs) energies.push_back (s.energyDb);
    std::vector<double> sorted = energies;
    std::sort (sorted.begin(), sorted.end());
    const double median = sorted[sorted.size() / 2];
    double sd = 0.0;
    for (double e : energies) sd += (e - median) * (e - median);
    sd = std::sqrt (sd / n) + 1.0e-6;

    auto clusterEnergy = [&] (int c) {
        double e = 0.0;
        for (int i : members[c]) e += segs[(size_t) i].energyDb;
        return e / (double) members[c].size();
    };
    auto clusterLength = [&] (int c) {
        double l = 0.0;
        for (int i : members[c]) l += segs[(size_t) i].length;
        return l / (double) members[c].size();
    };

    // Chorus: the loudest, most repeated part.
    int chorus = -1;
    double bestScore = -1.0e9;
    for (auto& [c, idx] : members)
    {
        if (idx.size() < 2)
            continue;
        const double score = (clusterEnergy (c) - median) / sd + 0.45 * (double) idx.size() + 0.1 * clusterLength (c) / 4.0;
        if (score > bestScore) { bestScore = score; chorus = c; }
    }
    const int firstChorus = chorus >= 0 ? members[chorus].front() : n;

    // Verse: repeated, appears before the first chorus, quieter than it.
    int verse = -1;
    for (auto& [c, idx] : members)
        if (c != chorus && idx.size() >= 2 && idx.front() < firstChorus && idx.front() > 0)
            if (verse < 0 || idx.front() < members[verse].front())
                verse = c;
    if (verse < 0) // e.g. the song starts with the verse at index 0
        for (auto& [c, idx] : members)
            if (c != chorus && idx.size() >= 2 && idx.front() < firstChorus)
                { verse = c; break; }

    // Pre-chorus: repeated short part that leads into the chorus.
    int preChorus = -1;
    for (auto& [c, idx] : members)
    {
        if (c == chorus || c == verse || idx.size() < 2 || clusterLength (c) > 8.0)
            continue;
        int leads = 0;
        for (int i : idx)
            if (i + 1 < n && segs[(size_t) (i + 1)].cluster == chorus)
                ++leads;
        if (leads * 2 >= (int) idx.size())
            preChorus = c;
    }

    for (int i = 0; i < n; ++i)
    {
        auto& s = segs[(size_t) i];
        const int c = s.cluster;
        const bool unique = members[c].size() == 1;
        const bool quiet = s.energyDb < median - 0.25 * sd;

        if (c == chorus) { s.kind = "chorus"; s.confidence = 0.7; }
        else if (c == verse) { s.kind = "verse"; s.confidence = 0.6; }
        else if (c == preChorus) { s.kind = "prechorus"; s.confidence = 0.5; }
        else if (i == 0 && (quiet || s.length <= 8)) { s.kind = "intro"; s.confidence = 0.6; }
        else if (i == n - 1 && (unique || quiet)) { s.kind = "outro"; s.confidence = 0.6; }
        else if (unique && i > firstChorus) { s.kind = "bridge"; s.confidence = 0.45; }
        else if (unique && i < firstChorus) { s.kind = (i + 1 == firstChorus && s.length <= 8) ? "prechorus" : "verse"; s.confidence = 0.4; }
        else if (s.length <= 4 || quiet) { s.kind = "interlude"; s.confidence = 0.4; }
        else { s.kind = "section"; s.confidence = 0.3; }
    }

    // First segment quieter than everything else -> intro even if it repeats later.
    if (n > 1 && segs[0].kind != "intro" && segs[0].kind != "chorus" && segs[0].length <= 8 && segs[0].energyDb < median - 0.5 * sd)
        segs[0].kind = "intro";
    // Last segment: a quiet tail after the final chorus is the ending.
    if (n > 2 && segs[(size_t) n - 1].kind != "outro" && segs[(size_t) n - 1].kind != "chorus" && segs[(size_t) n - 1].energyDb < median - 0.5 * sd)
        segs[(size_t) n - 1].kind = "outro";

    // Only one bridge: keep the longest, others become interludes.
    int bridgeIndex = -1;
    for (int i = 0; i < n; ++i)
        if (segs[(size_t) i].kind == "bridge" && (bridgeIndex < 0 || segs[(size_t) i].length > segs[(size_t) bridgeIndex].length))
            bridgeIndex = i;
    for (int i = 0; i < n; ++i)
        if (segs[(size_t) i].kind == "bridge" && i != bridgeIndex)
            segs[(size_t) i].kind = "interlude";
}

std::vector<Segment> mergeAdjacent (const std::vector<Segment>& segs)
{
    std::vector<Segment> out;
    for (const auto& s : segs)
    {
        if (! out.empty() && out.back().cluster == s.cluster && out.back().kind == s.kind)
        {
            out.back().length += s.length;
            continue;
        }
        out.push_back (s);
    }
    return out;
}

void assignLabels (std::vector<Segment>& segs)
{
    static const std::map<std::string, std::string> names {
        { "intro", "Intro" }, { "verse", "Estrofa" }, { "prechorus", "Pre-coro" }, { "chorus", "Coro" },
        { "bridge", "Puente" }, { "interlude", "Interludio" }, { "outro", "Final" }, { "section", "Secci\xc3\xb3n" }
    };
    std::map<std::string, int> total, seen;
    for (auto& s : segs) ++total[s.kind];
    for (auto& s : segs)
    {
        const int k = ++seen[s.kind];
        const auto& base = names.at (s.kind);
        const bool numbered = total[s.kind] > 1 && s.kind != "intro" && s.kind != "outro";
        s.label = numbered ? base + " " + std::to_string (k) : base;
    }
}
} // namespace

//==============================================================================
Input prepareInput (const SongData& song)
{
    Input in;
    in.sampleRate = analysisRate;
    const auto length = (size_t) song.lengthSamples;
    std::vector<float> music (length, 0.0f), click;

    bool hasMusic = false;
    for (const auto& t : song.tracks)
        hasMusic |= ! isClickTrackName (t.name) && ! isGuideTrackName (t.name);

    for (const auto& t : song.tracks)
    {
        const bool isClick = isClickTrackName (t.name);
        const bool isGuide = isGuideTrackName (t.name);
        std::vector<float>* target = nullptr;
        if (isClick)
        {
            if (click.empty()) click.assign (length, 0.0f);
            target = &click;
        }
        else if (! isGuide || ! hasMusic)
            target = &music;
        if (target == nullptr)
            continue;

        const float g = 1.0f / (float) t.audio.getNumChannels();
        for (int c = 0; c < t.audio.getNumChannels(); ++c)
            juce::FloatVectorOperations::addWithMultiply (target->data(), t.audio.getReadPointer (c), g, t.audio.getNumSamples());
    }
    if (! hasMusic && ! click.empty())
        music = click;

    in.music = resampleMono (music, song.sampleRate);
    in.click = resampleMono (click, song.sampleRate);
    return in;
}

Tempo detectTempo (const Input& input)
{
    const auto onsets = computeFrames (input.music, onsetOrder);
    if (onsets.size() < 64)
        return {};

    std::vector<float> clickEnv;
    Frames clickFrames;
    Tempo tempo;
    if (! input.click.empty())
    {
        clickFrames = computeFrames (input.click, onsetOrder);
        clickEnv = onsetEnvelope (clickFrames.flux, clickFrames.frameRate);
        tempo = tempoFromEnvelope (clickEnv, clickFrames.frameRate, clickFrames.timeOffsetSec);
        tempo.source = "click";
        // A click plays every beat: trust it unless it is nearly silent.
        if (! tempo.valid || tempo.confidence < 0.2)
            clickEnv.clear();
    }
    if (clickEnv.empty())
    {
        tempo = tempoFromEnvelope (onsetEnvelope (onsets.flux, onsets.frameRate), onsets.frameRate, onsets.timeOffsetSec);
        tempo.source = "mix";
    }
    if (! tempo.valid)
        return tempo;

    const auto features = computeFrames (input.music, featureOrder);
    tempo.downbeatOffsetSec = chooseDownbeat (tempo, onsets, onsetEnvelope (onsets.lowFlux, onsets.frameRate), features,
                                              clickEnv, clickEnv.empty() ? nullptr : &clickFrames);
    return tempo;
}

std::vector<Section> detectSections (const Input& input, const Tempo& tempo)
{
    const double durationSec = (double) input.music.size() / input.sampleRate;
    const auto frames = computeFrames (input.music);
    if (frames.size() < 64 || durationSec < 10.0)
        return {};

    // Bars of 4 beats. Without a tempo, use 2-second blocks.
    const bool haveTempo = tempo.valid && tempo.bpm > 30.0;
    const double barSec = haveTempo ? 4.0 * 60.0 / tempo.bpm : 2.0;
    auto bars = makeBars (frames, durationSec, barSec, haveTempo ? tempo.downbeatOffsetSec : 0.0);
    if (bars.size() < 6)
        return {};

    auto sim = similarityMatrix (bars);
    const auto novelty = noveltyCurve (sim, bars);
    const auto bounds = pickBoundaries (novelty);
    if (juce::SystemStats::getEnvironmentVariable ("LIVEPLAYER_DEBUG_ANALYSIS", {}).isNotEmpty())
    {
        for (size_t b = 0; b < bars.size(); ++b)
            std::printf ("    bar %3zu  t=%6.2f  E=%6.1f dB  nov=%6.3f%s\n", b, bars[b].startSec, bars[b].energyDb, novelty[b],
                         std::find (bounds.begin(), bounds.end(), (int) b) != bounds.end() ? "  <== boundary" : "");
    }

    std::vector<Segment> segs;
    for (size_t k = 0; k < bounds.size(); ++k)
    {
        Segment s;
        s.start = bounds[k];
        s.length = (k + 1 < bounds.size() ? bounds[k + 1] : (int) bars.size()) - s.start;
        double e = 0.0;
        for (int b = s.start; b < s.start + s.length; ++b) e += bars[(size_t) b].energyDb;
        s.energyDb = e / s.length;
        segs.push_back (s);
    }

    clusterSegments (segs, sim);
    nameSegments (segs);
    segs = mergeAdjacent (segs);
    assignLabels (segs);

    std::vector<Section> out;
    for (size_t k = 0; k < segs.size(); ++k)
    {
        Section sec;
        sec.startSec = bars[(size_t) segs[k].start].startSec;
        const int endBar = segs[k].start + segs[k].length;
        sec.endSec = endBar < (int) bars.size() ? bars[(size_t) endBar].startSec : durationSec;
        sec.kind = segs[k].kind;
        sec.label = segs[k].label;
        sec.confidence = segs[k].confidence;
        out.push_back (sec);
    }
    return out;
}

} // namespace liveplayer::analysis
