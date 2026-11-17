#include "Engine.h"

namespace liveplayer
{

//==============================================================================
class Engine::AnalysisJob final : public juce::Thread
{
public:
    AnalysisJob (SongPtr s, double bpm, double downbeat)
        : juce::Thread ("LIVEPLAYER analysis"), song (std::move (s)), bpmOverride (bpm), downbeatOverride (downbeat)
    {
    }

    ~AnalysisJob() override { stopThread (30000); }

    void run() override
    {
        try
        {
            const auto input = analysis::prepareInput (*song);
            if (threadShouldExit())
                return;

            analysis::Tempo tempo;
            if (bpmOverride > 0.0)
            {
                tempo.valid = true;
                tempo.bpm = bpmOverride;
                tempo.confidence = 1.0;
                tempo.downbeatOffsetSec = juce::jmax (0.0, downbeatOverride);
                tempo.beatOffsetSec = tempo.downbeatOffsetSec;
                tempo.source = "user";
            }
            else
            {
                tempo = analysis::detectTempo (input);
                detected = tempo;
                hasDetected = true;
            }
            if (threadShouldExit())
                return;

            result = analysis::detectSections (input, tempo);
            done.store (true);
        }
        catch (const std::exception& e)
        {
            error = e.what();
            failed.store (true);
        }
    }

    std::atomic<bool> done { false }, failed { false };
    analysis::Tempo detected;
    bool hasDetected = false;
    std::vector<analysis::Section> result;
    std::string error;

private:
    SongPtr song;
    double bpmOverride, downbeatOverride;
};

//==============================================================================
Engine::Engine() = default;

Engine::~Engine()
{
    loader.reset();
    analysis.reset();
    if (callbackAttached)
        deviceManager.removeAudioCallback (&player);
    deviceManager.closeAudioDevice();
    player.setSong (nullptr);
}

juce::String Engine::describeAudioDevicesJson()
{
    juce::Array<juce::var> types;

    // getAvailableDeviceTypes() lazily creates the platform back-ends
    // (WASAPI/DirectSound on Windows, CoreAudio on macOS, ...).
    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        type->scanForDevices();

        juce::Array<juce::var> outputs;
        for (const auto& name : type->getDeviceNames (false))
            outputs.add (name);

        auto* entry = new juce::DynamicObject();
        entry->setProperty ("name", type->getTypeName());
        entry->setProperty ("outputDevices", outputs);
        types.add (juce::var (entry));
    }

    auto* root = new juce::DynamicObject();
    root->setProperty ("deviceTypes", types);
    return juce::JSON::toString (juce::var (root), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none));
}

bool Engine::openDefaultOutput()
{
    if (deviceManager.getCurrentAudioDevice() != nullptr)
        return true;

    const auto err = deviceManager.initialiseWithDefaultDevices (0, 2);
    if (err.isNotEmpty() || deviceManager.getCurrentAudioDevice() == nullptr)
    {
        setLastError ("No se pudo abrir la salida de audio: "
                      + (err.isNotEmpty() ? err.toStdString() : std::string ("no hay dispositivo de salida")));
        return false;
    }

    if (! callbackAttached)
    {
        deviceManager.addAudioCallback (&player);
        callbackAttached = true;
    }
    return true;
}

juce::String Engine::getOutputInfoJson()
{
    auto* root = new juce::DynamicObject();
    auto* device = deviceManager.getCurrentAudioDevice();
    root->setProperty ("open", device != nullptr);
    if (device != nullptr)
    {
        const double rate = device->getCurrentSampleRate();
        root->setProperty ("typeName", device->getTypeName());
        root->setProperty ("deviceName", device->getName());
        root->setProperty ("sampleRate", rate);
        root->setProperty ("bufferSize", device->getCurrentBufferSizeSamples());
        root->setProperty ("outputLatencyMs",
                           rate > 0 ? 1000.0 * (device->getOutputLatencyInSamples() + device->getCurrentBufferSizeSamples()) / rate : 0.0);
    }
    return juce::JSON::toString (juce::var (root), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none));
}

bool Engine::loadSong (std::vector<TrackRequest> tracks)
{
    if (tracks.empty())
    {
        setLastError ("La canción no tiene pistas.");
        return false;
    }
    if (! openDefaultOutput())
        return false;

    loader.reset(); // cancels a load in progress
    currentLoadId = nextLoadId++;
    loadState = "loading";
    loadError.clear();
    loader = std::make_unique<SongLoader> (std::move (tracks), deviceManager.getCurrentAudioDevice()->getCurrentSampleRate(), currentLoadId);
    loader->startThread();
    return true;
}

void Engine::harvestLoader()
{
    if (loader == nullptr)
        return;

    switch (loader->getPhase())
    {
        case SongLoader::Phase::loading:
            return;

        case SongLoader::Phase::failed:
            loadState = "error";
            loadError = loader->getError();
            loader.reset();
            return;

        case SongLoader::Phase::ready:
        {
            analysis.reset();
            auto newSong = loader->getSong();
            trackPeaks = loader->takeTrackPeaks();
            mixPeaks = loader->takeMixPeaks();
            loader.reset();

            // Swap songs with the callback detached (the removal waits for any
            // running callback to finish), so the audio thread never sees a
            // half-installed song.
            if (callbackAttached)
                deviceManager.removeAudioCallback (&player);
            player.setSong (newSong);
            if (callbackAttached)
                deviceManager.addAudioCallback (&player);

            song = std::move (newSong); // the previous song is freed here, on the control thread
            loadState = "ready";
            detectedTempo = {};
            sections.clear();
            startAnalysis (0.0, 0.0);
            return;
        }
    }
}

void Engine::startAnalysis (double bpmOverride, double downbeatOverride)
{
    analysis.reset();
    analysisState = "running";
    analysis = std::make_unique<AnalysisJob> (song, bpmOverride, downbeatOverride);
    analysis->startThread (juce::Thread::Priority::low);
}

void Engine::harvestAnalysis()
{
    if (analysis == nullptr)
        return;
    if (analysis->failed.load())
    {
        analysisState = "error";
        setLastError ("Error en el análisis: " + analysis->error);
        analysis.reset();
    }
    else if (analysis->done.load())
    {
        if (analysis->hasDetected)
            detectedTempo = analysis->detected;
        sections = std::move (analysis->result);
        analysisState = "done";
        ++analysisRevision;
        analysis.reset();
    }
}

bool Engine::detectSections (double bpm, double downbeatOffsetSec)
{
    if (song == nullptr)
    {
        setLastError ("No hay ninguna canción cargada.");
        return false;
    }
    if (bpm <= 0.0 && detectedTempo.valid)
    {
        bpm = detectedTempo.bpm;
        downbeatOffsetSec = detectedTempo.downbeatOffsetSec;
    }
    startAnalysis (bpm, downbeatOffsetSec);
    return true;
}

juce::String Engine::getSongStatusJson()
{
    harvestLoader();
    harvestAnalysis();

    auto* root = new juce::DynamicObject();
    root->setProperty ("state", juce::String (loadState));
    root->setProperty ("progress", loader != nullptr ? (double) loader->getProgress() : (loadState == "ready" ? 1.0 : 0.0));
    root->setProperty ("error", juce::String (loadError));
    root->setProperty ("loadId", (juce::int64) currentLoadId);

    if (song != nullptr)
    {
        auto* s = new juce::DynamicObject();
        s->setProperty ("sampleRate", song->sampleRate);
        s->setProperty ("durationSec", song->durationSec());
        s->setProperty ("memoryMB", (double) song->memoryBytes() / (1024.0 * 1024.0));
        juce::Array<juce::var> tracks;
        for (const auto& t : song->tracks)
        {
            auto* tr = new juce::DynamicObject();
            tr->setProperty ("name", juce::String::fromUTF8 (t.name.c_str()));
            tr->setProperty ("path", juce::String::fromUTF8 (t.path.c_str()));
            tr->setProperty ("format", juce::String (t.format));
            tr->setProperty ("sourceSampleRate", t.sourceSampleRate);
            tr->setProperty ("channels", t.sourceChannels);
            tr->setProperty ("durationSec", (double) t.audio.getNumSamples() / song->sampleRate);
            tr->setProperty ("resampled", t.resampled);
            tracks.add (juce::var (tr));
        }
        s->setProperty ("tracks", tracks);
        root->setProperty ("song", juce::var (s));

        auto* a = new juce::DynamicObject();
        a->setProperty ("state", juce::String (analysisState));
        a->setProperty ("revision", analysisRevision);
        if (detectedTempo.valid)
        {
            auto* t = new juce::DynamicObject();
            t->setProperty ("bpm", detectedTempo.bpm);
            t->setProperty ("confidence", detectedTempo.confidence);
            t->setProperty ("beatOffsetSec", detectedTempo.beatOffsetSec);
            t->setProperty ("downbeatOffsetSec", detectedTempo.downbeatOffsetSec);
            t->setProperty ("source", juce::String (detectedTempo.source));
            a->setProperty ("tempo", juce::var (t));
        }
        juce::Array<juce::var> secs;
        for (const auto& sec : sections)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("startSec", sec.startSec);
            o->setProperty ("endSec", sec.endSec);
            o->setProperty ("kind", juce::String (sec.kind));
            o->setProperty ("label", juce::String::fromUTF8 (sec.label.c_str()));
            o->setProperty ("confidence", sec.confidence);
            secs.add (juce::var (o));
        }
        a->setProperty ("sections", secs);
        root->setProperty ("analysis", juce::var (a));
    }

    return juce::JSON::toString (juce::var (root), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none));
}

bool Engine::getPeaks (int track, std::vector<juce::uint8>& out)
{
    if (song == nullptr)
        return false;
    if (track < 0)
    {
        out = mixPeaks;
        return true;
    }
    if (track >= (int) trackPeaks.size())
        return false;
    out = trackPeaks[(size_t) track];
    return true;
}

Engine::TransportExtras Engine::getTransportExtras()
{
    TransportExtras extras;
    extras.audioLoad = deviceManager.getCpuUsage();
    if (auto* device = deviceManager.getCurrentAudioDevice())
        extras.deviceXruns = device->getXRunCount();
    return extras;
}

} // namespace liveplayer
