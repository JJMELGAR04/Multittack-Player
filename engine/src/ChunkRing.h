#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cstdint>
#include <vector>

namespace liveplayer
{

/** Metadata travelling with every rendered chunk. */
struct ChunkMeta
{
    uint32_t generation = 0;  // seek generation the chunk belongs to
    double sourcePos = 0.0;   // song position (samples) of the chunk's first frame
    double rate = 1.0;        // song samples advanced per output frame
    bool end = false;         // past the end of the song (chunk is silent)
};

/**
 * Lock-free single-producer / single-consumer ring of fixed-size audio chunks.
 * Producer: render thread. Consumer: audio callback.
 * Every chunk carries all output channels (2 per track) so that per-track
 * gain/routing can be applied on the audio thread in later phases with zero
 * added latency.
 * prepare() must only be called while neither side is running.
 */
class ChunkRing
{
public:
    static constexpr int chunkFrames = 256;

    void prepare (int numChannels, int numChunks)
    {
        jassert (numChunks > 1 && numChannels > 0);
        channels = numChannels;
        capacity = numChunks;
        data.setSize (numChannels, numChunks * chunkFrames, false, true, false);
        data.clear();
        meta.assign ((size_t) numChunks, ChunkMeta{});
        writeCount.store (0);
        readCount.store (0);
    }

    int numChannels() const noexcept { return channels; }
    int numChunks() const noexcept { return capacity; }

    // ---- producer ----
    int freeChunks() const noexcept
    {
        return capacity - (int) (writeCount.load (std::memory_order_relaxed) - readCount.load (std::memory_order_acquire));
    }
    float* writePointer (int channel) noexcept { return data.getWritePointer (channel, slot (writeCount.load (std::memory_order_relaxed)) * chunkFrames); }
    ChunkMeta& writeMeta() noexcept { return meta[(size_t) slot (writeCount.load (std::memory_order_relaxed))]; }
    void commitWrite() noexcept { writeCount.fetch_add (1, std::memory_order_release); }

    // ---- consumer ----
    int availableChunks() const noexcept
    {
        return (int) (writeCount.load (std::memory_order_acquire) - readCount.load (std::memory_order_relaxed));
    }
    const float* readPointer (int channel) const noexcept { return data.getReadPointer (channel, slot (readCount.load (std::memory_order_relaxed)) * chunkFrames); }
    const ChunkMeta& readMeta() const noexcept { return meta[(size_t) slot (readCount.load (std::memory_order_relaxed))]; }
    void commitRead() noexcept { readCount.fetch_add (1, std::memory_order_release); }

private:
    int slot (uint64_t count) const noexcept { return (int) (count % (uint64_t) capacity); }

    int channels = 0;
    int capacity = 0;
    juce::AudioBuffer<float> data;
    std::vector<ChunkMeta> meta;
    std::atomic<uint64_t> writeCount { 0 }, readCount { 0 };
};

} // namespace liveplayer
