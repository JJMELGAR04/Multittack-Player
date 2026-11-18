#include "SongLoader.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <CDSPResampler.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <thread>
#include <utility>

namespace liveplayer
{

namespace
{
std::string lower (std::string s)
{
    std::transform (s.begin(), s.end(), s.begin(), [] (unsigned char c) { return (char) std::tolower (c); });
    return s;
}

/** Words of a file name ("Click_Track-01" -> click, track, 01). UTF-8 bytes kept. */
std::vector<std::string> words (const std::string& name)
{
    std::vector<std::string> out;
    std::string current;
    for (char ch : lower (name))
    {
        const auto u = (unsigned char) ch;
        if (std::isalnum (u) || u >= 0x80)
            current += ch;
        else if (! current.empty())
            out.push_back (std::exchange (current, {}));
    }
    if (! current.empty())
        out.push_back (current);
    return out;
}

bool hasWordStartingWith (const std::string& name, std::initializer_list<const char*> prefixes)
{
    for (const auto& w : words (name))
        for (auto* p : prefixes)
            if (w.rfind (p, 0) == 0)
                return true;
    return false;
}

constexpr juce::int64 maxSongSamples = (juce::int64) 48000 * 60 * 60 * 2; // 2 h @ 48 kHz
} // namespace

bool isClickTrackName (const std::string& name)
{
    return hasWordStartingWith (name, { "click", "clic", "metr", "countin", "conteo" });
}

bool isGuideTrackName (const std::string& name)
{
    // Whole words only: "cue" must not match "cuerdas".
    for (const auto& w : words (name))
        if (w == "guide" || w == "guides" || w == "guia" || w == "guias" || w == "gu\xc3\xad" "a" || w == "gu\xc3\xad" "as"
            || w == "cue" || w == "cues" || w == "cues")
            return true;
    return false;
}

//==============================================================================
Mp3GaplessInfo readMp3GaplessInfo (const juce::File& file)
{
    Mp3GaplessInfo info;
    juce::FileInputStream in (file);
    if (! in.openedOk())
        return info;

    juce::MemoryBlock head;
    in.readIntoMemoryBlock (head, 256 * 1024);
    const auto* d = static_cast<const juce::uint8*> (head.getData());
    const size_t size = head.getSize();

    // Skip an ID3v2 tag (syncsafe size).
    size_t pos = 0;
    if (size >= 10 && d[0] == 'I' && d[1] == 'D' && d[2] == '3')
    {
        const size_t tagSize = ((size_t) (d[6] & 0x7f) << 21) | ((size_t) (d[7] & 0x7f) << 14)
                             | ((size_t) (d[8] & 0x7f) << 7) | (size_t) (d[9] & 0x7f);
        pos = 10 + tagSize + ((d[5] & 0x10) ? 10 : 0);
    }

    // First frame sync.
    while (pos + 4 < size && ! (d[pos] == 0xff && (d[pos + 1] & 0xe0) == 0xe0))
        ++pos;
    if (pos + 4 >= size)
        return info;

    const int versionBits = (d[pos + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const int layerBits = (d[pos + 1] >> 1) & 3;   // 1 = Layer III
    const bool mono = ((d[pos + 3] >> 6) & 3) == 3;
    if (layerBits != 1)
        return info;
    const bool mpeg1 = versionBits == 3;
    info.samplesPerFrame = mpeg1 ? 1152 : 576;

    const size_t sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    size_t x = pos + 4 + sideInfo;
    if (x + 8 > size)
        return info;
    const bool xing = std::memcmp (d + x, "Xing", 4) == 0 || std::memcmp (d + x, "Info", 4) == 0;
    if (! xing)
        return info;

    const juce::uint32 flags = ((juce::uint32) d[x + 4] << 24) | ((juce::uint32) d[x + 5] << 16) | ((juce::uint32) d[x + 6] << 8) | d[x + 7];
    size_t p = x + 8;
    if (flags & 1)
    {
        if (p + 4 > size) return info;
        info.frames = ((juce::int64) d[p] << 24) | ((juce::int64) d[p + 1] << 16) | ((juce::int64) d[p + 2] << 8) | d[p + 3];
        p += 4;
    }
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;

    // LAME extension (also written by FFmpeg as "Lavc"/"Lavf").
    if (p + 24 > size)
        return info;
    const bool lameTag = std::memcmp (d + p, "LAME", 4) == 0 || std::memcmp (d + p, "Lavc", 4) == 0
                      || std::memcmp (d + p, "Lavf", 4) == 0 || std::memcmp (d + p, "L3.9", 4) == 0;
    if (! lameTag)
        return info;

    const size_t dp = p + 21;
    info.encoderDelay = (d[dp] << 4) | (d[dp + 1] >> 4);
    info.encoderPadding = ((d[dp + 1] & 0x0f) << 8) | d[dp + 2];
    info.valid = info.encoderDelay < 4096 && info.encoderPadding < 4096;
    return info;
}

//==============================================================================
std::vector<juce::uint8> computePeaks (const juce::AudioBuffer<float>& audio, int hop, float gain)
{
    const int length = audio.getNumSamples();
    const int buckets = (length + hop - 1) / hop;
    std::vector<float> raw ((size_t) buckets, 0.0f);

    for (int c = 0; c < audio.getNumChannels(); ++c)
    {
        const float* s = audio.getReadPointer (c);
        for (int b = 0; b < buckets; ++b)
        {
            const int start = b * hop;
            const int n = juce::jmin (hop, length - start);
            const auto range = juce::FloatVectorOperations::findMinAndMax (s + start, n);
            raw[(size_t) b] = juce::jmax (raw[(size_t) b], std::abs (range.getStart()), std::abs (range.getEnd()));
        }
    }

    std::vector<juce::uint8> peaks ((size_t) buckets, 0);
    for (int b = 0; b < buckets; ++b)
        peaks[(size_t) b] = (juce::uint8) juce::jlimit (0, 255, (int) std::lround (raw[(size_t) b] * gain * 255.0f));
    return peaks;
}

namespace
{
/** Peaks normalised to the loudest bucket, so quiet stems stay readable. */
std::vector<juce::uint8> normalisedPeaks (const juce::AudioBuffer<float>& audio, int hop)
{
    float maxAbs = 0.0f;
    for (int c = 0; c < audio.getNumChannels(); ++c)
        maxAbs = juce::jmax (maxAbs, audio.getMagnitude (c, 0, audio.getNumSamples()));
    return computePeaks (audio, hop, maxAbs > 1.0e-4f ? 1.0f / maxAbs : 1.0f);
}
} // namespace

float computeBusPeak (const SongData& song, const std::vector<int>& buses, int bus)
{
    constexpr int block = 1 << 15;
    juce::AudioBuffer<float> sum (2, block);
    float peak = 0.0f;
    for (juce::int64 start = 0; start < song.lengthSamples; start += block)
    {
        const int n = (int) juce::jmin<juce::int64> (block, song.lengthSamples - start);
        sum.clear();
        for (size_t i = 0; i < song.tracks.size(); ++i)
        {
            if ((i < buses.size() ? buses[i] : song.tracks[i].bus) != bus)
                continue;
            const auto& a = song.tracks[i].audio;
            const int avail = (int) juce::jlimit<juce::int64> (0, n, a.getNumSamples() - start);
            if (avail <= 0)
                continue;
            const bool mono = a.getNumChannels() == 1;
            for (int c = 0; c < 2; ++c)
                sum.addFrom (c, 0, a, mono ? 0 : c, (int) start, avail, mono && ! song.tracks[i].dualMono ? 0.70710678f : 1.0f);
        }
        for (int c = 0; c < 2; ++c)
            peak = juce::jmax (peak, sum.getMagnitude (c, 0, n));
    }
    return peak;
}

std::vector<juce::uint8> computeMixPeaks (const SongData& song, const std::vector<int>& roles)
{
    bool hasMusic = false;
    for (size_t i = 0; i < song.tracks.size(); ++i)
        hasMusic |= i >= roles.size() || roles[i] == roleMusic;

    juce::AudioBuffer<float> mix (1, (int) song.lengthSamples);
    mix.clear();
    for (size_t i = 0; i < song.tracks.size(); ++i)
    {
        if (hasMusic && i < roles.size() && roles[i] != roleMusic)
            continue;
        const auto& t = song.tracks[i];
        const float g = t.audio.getNumChannels() == 1 ? 1.0f : 0.5f;
        for (int c = 0; c < t.audio.getNumChannels(); ++c)
            mix.addFrom (0, 0, t.audio, c, 0, t.audio.getNumSamples(), g);
    }
    return normalisedPeaks (mix, juce::jmax (1, (int) std::lround (song.sampleRate / 100.0)));
}

//==============================================================================
// ---- Decoded-audio cache -----------------------------------------------------
// Decoding MP3s and converting the sample rate is the slow part of loading a
// song. The result is kept on disk (raw 32-bit float, bit-exact), so opening
// the same song again only reads it back. Entries are keyed by the source
// file (path, size, date) and the device sample rate; stale ones never match.

namespace
{
constexpr juce::uint32 cacheMagic = 0x3143504c; // "LPC1"
constexpr juce::uint32 cacheVersion = 1;
}

juce::File SongLoader::cacheFileFor (const juce::File& source) const
{
    const auto key = source.getFullPathName() + "|" + juce::String (source.getSize()) + "|"
                     + juce::String (source.getLastModificationTime().toMilliseconds()) + "|" + juce::String (sampleRate, 1);
    const auto hex = juce::String::toHexString ((juce::int64) key.hashCode64()) + juce::String::toHexString (key.toLowerCase().hashCode());
    return cacheDir.getChildFile (hex + ".lpc");
}

bool SongLoader::readCache (const juce::File& source, TrackData& out) const
{
    if (cacheDir == juce::File())
        return false;
    const auto file = cacheFileFor (source);
    juce::FileInputStream in (file);
    if (! in.openedOk())
        return false;
    if ((juce::uint32) in.readInt() != cacheMagic || (juce::uint32) in.readInt() != cacheVersion)
        return false;
    if (std::abs (in.readDouble() - sampleRate) > 0.5 || in.readInt64() != source.getSize()
        || in.readInt64() != source.getLastModificationTime().toMilliseconds() || in.readString() != source.getFullPathName())
        return false;
    const int channels = in.readInt();
    const auto frames = in.readInt64();
    const int sourceRate = in.readInt();
    const int sourceChannels = in.readInt();
    const bool resampled = in.readByte() != 0;
    const bool dualMono = in.readByte() != 0;
    if (channels < 1 || channels > 2 || frames <= 0 || frames > maxSongSamples
        || in.getTotalLength() - in.getPosition() != (juce::int64) channels * frames * (juce::int64) sizeof (float))
        return false;
    juce::AudioBuffer<float> audio (channels, (int) frames);
    for (int c = 0; c < channels; ++c)
        if (in.read (audio.getWritePointer (c), (int) (frames * (juce::int64) sizeof (float))) != (int) (frames * (juce::int64) sizeof (float)))
            return false;
    out.audio = std::move (audio);
    out.sourceSampleRate = sourceRate;
    out.sourceChannels = sourceChannels;
    out.resampled = resampled;
    out.dualMono = dualMono;
    out.fromCache = true;
    file.setLastModificationTime (juce::Time::getCurrentTime()); // recently used: kept longer
    return true;
}

void SongLoader::writeCache (const juce::File& source, const TrackData& t) const
{
    if (cacheDir == juce::File() || ! cacheDir.createDirectory())
        return;
    const auto file = cacheFileFor (source);
    const auto tmp = file.withFileExtension ("tmp");
    {
        juce::FileOutputStream out (tmp);
        if (! out.openedOk())
            return;
        out.setPosition (0);
        out.truncate();
        out.writeInt ((int) cacheMagic);
        out.writeInt ((int) cacheVersion);
        out.writeDouble (sampleRate);
        out.writeInt64 (source.getSize());
        out.writeInt64 (source.getLastModificationTime().toMilliseconds());
        out.writeString (source.getFullPathName());
        out.writeInt (t.audio.getNumChannels());
        out.writeInt64 (t.audio.getNumSamples());
        out.writeInt (t.sourceSampleRate);
        out.writeInt (t.sourceChannels);
        out.writeByte (t.resampled ? 1 : 0);
        out.writeByte (t.dualMono ? 1 : 0);
        for (int c = 0; c < t.audio.getNumChannels(); ++c)
            out.write (t.audio.getReadPointer (c), (size_t) t.audio.getNumSamples() * sizeof (float));
        out.flush();
        if (out.getStatus().failed())
        {
            tmp.deleteFile(); // disk full or similar: simply no cache
            return;
        }
    }
    if (! tmp.moveFileTo (file))
        tmp.deleteFile();
}

void SongLoader::trimCache() const
{
    if (cacheDir == juce::File() || cacheMaxBytes <= 0)
        return;
    auto files = cacheDir.findChildFiles (juce::File::findFiles, false, "*.lpc");
    std::sort (files.begin(), files.end(), [] (const juce::File& a, const juce::File& b) {
        return a.getLastModificationTime() < b.getLastModificationTime();
    });
    juce::int64 total = 0;
    for (auto& f : files)
        total += f.getSize();
    // Oldest first, never the files of the song just loaded.
    for (auto& f : files)
    {
        if (total <= cacheMaxBytes || f.getLastModificationTime() >= startedAt - juce::RelativeTime::seconds (1.0))
            break;
        total -= f.getSize();
        f.deleteFile();
    }
}

SongLoader::SongLoader (std::vector<TrackRequest> tracks, double targetSampleRate, juce::uint64 id, juce::File cache, juce::int64 cacheMax)
    : juce::Thread ("LIVEPLAYER loader"),
      requests (std::move (tracks)),
      sampleRate (targetSampleRate),
      loadId (id),
      cacheDir (std::move (cache)),
      cacheMaxBytes (cacheMax),
      trackProgress (requests.size())
{
}

SongLoader::~SongLoader()
{
    stopThread (30000);
}

SongPtr SongLoader::getSong() const
{
    std::scoped_lock lock (mutex);
    return song;
}

std::vector<std::vector<juce::uint8>> SongLoader::takeTrackPeaks()
{
    std::scoped_lock lock (mutex);
    return std::move (trackPeaks);
}

std::vector<juce::uint8> SongLoader::takeMixPeaks()
{
    std::scoped_lock lock (mutex);
    return std::move (mixPeaks);
}

std::string SongLoader::getError() const
{
    std::scoped_lock lock (mutex);
    return error;
}

void SongLoader::fail (std::string message)
{
    {
        std::scoped_lock lock (mutex);
        error = std::move (message);
    }
    phase.store (Phase::failed);
}

bool SongLoader::decodeTrack (size_t index, TrackData& out, std::string& err)
{
    const auto& req = requests[index];
    const juce::File file (juce::String::fromUTF8 (req.path.c_str()));
    out.path = req.path;
    out.name = req.name.empty() ? file.getFileNameWithoutExtension().toStdString() : req.name;
    out.format = file.getFileExtension().substring (1).toUpperCase().toStdString();
    out.role = req.role >= 0 ? req.role : (isClickTrackName (out.name) ? roleClick : isGuideTrackName (out.name) ? roleGuide : roleMusic);
    out.bus = req.bus >= 0 ? req.bus : (out.role == roleMusic ? busMain : busMonitor);
    out.voice = req.voice;

    if (! file.existsAsFile())
    {
        err = "No se encuentra el archivo: " + req.path;
        return false;
    }

    if (readCache (file, out))
    {
        trackProgress[index].store (1.0f);
        return true;
    }

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));
    if (reader == nullptr)
    {
        err = "Formato no soportado o archivo dañado: " + file.getFileName().toStdString();
        return false;
    }

    const auto length = reader->lengthInSamples;
    if (length <= 0 || length > maxSongSamples || reader->sampleRate < 8000.0)
    {
        err = "El archivo no contiene audio válido: " + file.getFileName().toStdString();
        return false;
    }

    out.sourceSampleRate = (int) std::lround (reader->sampleRate);
    out.sourceChannels = (int) reader->numChannels;
    const int channels = juce::jmin (2, (int) reader->numChannels);

    juce::AudioBuffer<float> decoded (channels, (int) length);
    constexpr int block = 1 << 18;
    for (juce::int64 pos = 0; pos < length; pos += block)
    {
        if (threadShouldExit())
            return false;
        const int n = (int) juce::jmin<juce::int64> (block, length - pos);
        reader->read (&decoded, (int) pos, n, pos, true, channels > 1);
        trackProgress[index].store (0.85f * (float) (pos + n) / (float) length);
    }

    // "Stereo" files whose two channels are identical (very common for stems)
    // are kept as one channel: half the memory, same sound (played at full
    // level on both sides, see SongRenderer).
    int keep = channels;
    if (channels == 2
        && std::memcmp (decoded.getReadPointer (0), decoded.getReadPointer (1), (size_t) length * sizeof (float)) == 0)
    {
        keep = 1;
        out.dualMono = true;
    }

    // MP3: remove encoder + decoder delay so the stem lines up with WAV stems.
    juce::int64 start = 0, usable = length;
    if (out.format == "MP3")
    {
        const auto gapless = readMp3GaplessInfo (file);
        if (gapless.valid)
        {
            start = gapless.encoderDelay + mp3DecoderDelay;
            usable = gapless.frames > 0
                         ? gapless.frames * gapless.samplesPerFrame - gapless.encoderDelay - gapless.encoderPadding
                         : length - start;
        }
        else
        {
            start = mp3DecoderDelay; // decoder delay is always present
            usable = length - start;
        }
        usable = juce::jlimit<juce::int64> (0, length - start, usable);
    }

    if (std::abs (reader->sampleRate - sampleRate) < 0.5)
    {
        out.audio.setSize (keep, (int) usable);
        for (int c = 0; c < keep; ++c)
            out.audio.copyFrom (c, 0, decoded, c, (int) start, (int) usable);
    }
    else
    {
        // High-quality sample-rate conversion (r8brain, 24-bit grade, linear phase).
        out.resampled = true;
        const auto outLength = (int) std::ceil ((double) usable * sampleRate / reader->sampleRate);
        out.audio.setSize (keep, outLength);
        for (int c = 0; c < keep; ++c)
        {
            if (threadShouldExit())
                return false;
            r8b::CDSPResampler24 resampler (reader->sampleRate, sampleRate, 1 << 16);
            resampler.oneshot (decoded.getReadPointer (c, (int) start), (int) usable, out.audio.getWritePointer (c), outLength);
        }
    }

    writeCache (file, out);
    trackProgress[index].store (1.0f);
    return true;
}

void SongLoader::run()
{
    if (requests.empty())
    {
        fail ("La canción no tiene pistas.");
        return;
    }

    auto data = std::make_shared<SongData>();
    data->sampleRate = sampleRate;
    data->tracks.resize (requests.size());
    std::vector<std::string> errors (requests.size());

    // Decode several files at once (the machine has spare cores while loading).
    std::atomic<size_t> next { 0 };
    std::atomic<bool> anyFailed { false };
    const size_t workers = juce::jlimit<size_t> (1, requests.size(), (size_t) juce::jmax (1, (int) std::thread::hardware_concurrency() - 1));
    std::atomic<size_t> finished { 0 };
    std::vector<std::thread> pool;
    for (size_t w = 0; w < workers; ++w)
        pool.emplace_back ([&] {
           #if JUCE_WINDOWS
            // Decoding runs below normal priority: on modest computers the
            // interface (and the song that is playing) stay responsive.
            SetThreadPriority (GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
           #endif
            for (size_t i = next++; i < requests.size(); i = next++)
            {
                if (anyFailed.load() || threadShouldExit())
                    break;
                try
                {
                    if (! decodeTrack (i, data->tracks[i], errors[i]))
                        anyFailed.store (true);
                }
                catch (const std::exception& e)
                {
                    errors[i] = std::string ("Error al decodificar: ") + e.what();
                    anyFailed.store (true);
                }
            }
            ++finished;
        });

    while (finished.load() < workers)
    {
        float sum = 0.0f;
        for (auto& p : trackProgress)
            sum += p.load();
        progress.store (0.9f * sum / (float) requests.size());
        juce::Thread::sleep (30);
    }
    for (auto& t : pool)
        t.join();

    if (threadShouldExit())
        return;

    if (anyFailed.load())
    {
        for (auto& e : errors)
            if (! e.empty())
            {
                fail (e);
                return;
            }
        fail ("No se pudo cargar la canción.");
        return;
    }

    for (const auto& t : data->tracks)
    {
        data->lengthSamples = juce::jmax (data->lengthSamples, (juce::int64) t.audio.getNumSamples());
        data->cachedTracks += t.fromCache ? 1 : 0;
    }
    trimCache();

    // Waveform overviews.
    const int hop = juce::jmax (1, (int) std::lround (sampleRate / 100.0));
    std::vector<std::vector<juce::uint8>> peaks;
    for (const auto& t : data->tracks)
        peaks.push_back (normalisedPeaks (t.audio, hop));

    std::vector<int> roles;
    for (const auto& t : data->tracks)
        roles.push_back (t.role);
    auto mixOverview = computeMixPeaks (*data, roles);

    data->loadSeconds = (juce::Time::getMillisecondCounter() - startedMs) / 1000.0;
    {
        std::scoped_lock lock (mutex);
        song = std::move (data);
        trackPeaks = std::move (peaks);
        mixPeaks = std::move (mixOverview);
    }
    progress.store (1.0f);
    phase.store (Phase::ready);
}

} // namespace liveplayer
