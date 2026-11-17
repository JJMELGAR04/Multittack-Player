#pragma once

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace liveplayer
{

/**
 * Transparent stereo-linked look-ahead peak limiter (safety net on each
 * output bus). Real-time safe: all memory is allocated in prepare().
 *
 * Design (peak-hold + box filter): the gain needed for every sample is held
 * for L samples (sliding minimum), released smoothly, then averaged over L
 * samples. With the audio delayed by L - 1 samples the averaged gain is
 * guaranteed to be at or below the needed gain at every peak, so the output
 * never exceeds the ceiling and the gain never steps (no clicks, no clipping
 * distortion). Normally idle: the per-song level trim keeps buses below it.
 */
class Limiter
{
public:
    void prepare (double sampleRate, int lookaheadSamples, float ceiling = 0.944f /* -0.5 dBFS */)
    {
        L = std::max (2, lookaheadSamples);
        threshold = ceiling;
        releaseCoef = (float) (1.0 - std::exp (-1.0 / (0.08 * sampleRate))); // ~80 ms
        delay[0].assign ((size_t) L - 1, 0.0f);
        delay[1].assign ((size_t) L - 1, 0.0f);
        box.assign ((size_t) L, 1.0f);
        dequeValue.assign ((size_t) L + 1, 1.0f);
        dequeIndex.assign ((size_t) L + 1, 0);
        reset();
    }

    void reset()
    {
        std::fill (delay[0].begin(), delay[0].end(), 0.0f);
        std::fill (delay[1].begin(), delay[1].end(), 0.0f);
        std::fill (box.begin(), box.end(), 1.0f);
        boxSum = (double) L;
        released = 1.0f;
        head = tail = 0;
        n = 0;
        pos = 0;
        dpos = 0;
        minGain = 1.0f;
    }

    int latency() const noexcept { return L - 1; }

    /** Lowest gain applied since the last call (1 = no limiting). */
    float takeMinGain() noexcept
    {
        const float g = minGain;
        minGain = 1.0f;
        return g;
    }

    void process (float* left, float* right, int frames) noexcept
    {
        const int cap = L + 1;
        for (int i = 0; i < frames; ++i)
        {
            const float l = left[i], r = right[i];
            const float peak = std::max (std::abs (l), std::abs (r));
            const float need = peak > threshold ? threshold / peak : 1.0f;

            // Sliding minimum of the needed gain over the last L samples.
            while (head != tail && dequeValue[(size_t) ((tail + cap - 1) % cap)] >= need)
                tail = (tail + cap - 1) % cap;
            dequeValue[(size_t) tail] = need;
            dequeIndex[(size_t) tail] = n;
            tail = (tail + 1) % cap;
            while (dequeIndex[(size_t) head] <= n - L)
                head = (head + 1) % cap;
            const float held = dequeValue[(size_t) head];

            // Instant reduction, smooth release.
            released = held < released ? held : released + (held - released) * releaseCoef;

            // Box filter over L samples.
            boxSum += (double) released - (double) box[(size_t) pos];
            box[(size_t) pos] = released;
            const float gain = (float) std::min (1.0, boxSum / L);
            minGain = std::min (minGain, gain);

            pos = (pos + 1) % L;

            // Audio delayed by L - 1 samples (the sample that entered L - 1 steps ago).
            const float dl = delay[0][(size_t) dpos], dr = delay[1][(size_t) dpos];
            delay[0][(size_t) dpos] = l;
            delay[1][(size_t) dpos] = r;
            dpos = (dpos + 1) % (L - 1);
            left[i] = dl * gain;
            right[i] = dr * gain;
            ++n;
        }
    }

private:
    int L = 48;
    float threshold = 0.944f;
    float releaseCoef = 0.0f;
    std::vector<float> delay[2];
    std::vector<float> box;
    double boxSum = 0.0;
    float released = 1.0f;
    std::vector<float> dequeValue;
    std::vector<long long> dequeIndex;
    int head = 0, tail = 0;
    long long n = 0;
    int pos = 0, dpos = 0;
    float minGain = 1.0f;
};

} // namespace liveplayer
