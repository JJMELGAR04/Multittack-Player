#include "Engine.h"

#include <cmath>

namespace liveplayer
{

//==============================================================================
class Engine::AnalysisJob final : public juce::Thread
{
public:
    AnalysisJob (SongPtr s, std::vector<analysis::TrackRole> r, double bpm, double downbeat, int beats)
        : juce::Thread ("LIVEPLAYER analysis"), song (std::move (s)), roles (std::move (r)),
          bpmOverride (bpm), downbeatOverride (downbeat), beatsPerBar (beats)
    {
    }

    ~AnalysisJob() override { stopThread (30000); }

    void run() override
    {
        try
        {
            const auto input = analysis::prepareInput (*song, roles);
            if (threadShouldExit())
                return;

            analysis::Tempo tempo;
            if (bpmOverride > 0.0 && downbeatOverride < 0.0)
            {
                // Known tempo: only the beat phase and the first bar line are estimated.
                tempo = analysis::alignTempo (input, bpmOverride, beatsPerBar);
                tempo.source = "user";
                detected = tempo;
                hasDetected = true;
            }
            else if (bpmOverride > 0.0)
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
                tempo = analysis::detectTempo (input, beatsPerBar);
                detected = tempo;
                hasDetected = true;
            }
            if (threadShouldExit())
                return;

            result = analysis::detectSections (input, tempo, beatsPerBar);
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
    std::vector<analysis::TrackRole> roles;
    double bpmOverride, downbeatOverride;
    int beatsPerBar;
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

    // Up to 4 outputs: 1/2 instruments, 3/4 click + cues (when the device has them).
    const auto err = deviceManager.initialiseWithDefaultDevices (0, 4);
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
        root->setProperty ("outputChannels", device->getActiveOutputChannels().countNumberOfSetBits());
        root->setProperty ("outputLatencyMs",
                           rate > 0 ? 1000.0 * (device->getOutputLatencyInSamples() + device->getCurrentBufferSizeSamples()) / rate : 0.0);
    }
    return juce::JSON::toString (juce::var (root), juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none));
}

bool Engine::loadSong (std::vector<TrackRequest> tracks, double bpm, int beats)
{
    if (tracks.empty())
    {
        setLastError ("La canción no tiene pistas.");
        return false;
    }
    if (! openDefaultOutput())
        return false;

    loader.reset(); // cancels a load in progress
    pendingBpmHint = bpm > 0.0 ? bpm : 0.0;
    pendingBeatsPerBar = juce::jlimit (1, 16, beats);
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
            trackRoles.clear();
            trackBuses.clear();
            for (const auto& t : song->tracks)
            {
                trackRoles.push_back (t.role);
                trackBuses.push_back (t.bus);
            }
            mixPeaksDirty = false;
            updateBusTrims();
            bpmHint = pendingBpmHint;
            beatsPerBar = pendingBeatsPerBar;
            loadState = "ready";
            detectedTempo = {};
            sections.clear();
            startAnalysis (bpmHint, -1.0, beatsPerBar);
            return;
        }
    }
}

void Engine::startAnalysis (double bpm, double downbeat, int beats)
{
    analysis.reset();
    analysisState = "running";
    std::vector<analysis::TrackRole> roles;
    for (int r : trackRoles)
        roles.push_back (r == roleClick ? analysis::TrackRole::click : r == roleGuide ? analysis::TrackRole::guide : analysis::TrackRole::music);
    analysis = std::make_unique<AnalysisJob> (song, std::move (roles), bpm, downbeat, beats);
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

bool Engine::detectSections (double bpm, double downbeatOffsetSec, int beats)
{
    if (song == nullptr)
    {
        setLastError ("No hay ninguna canción cargada.");
        return false;
    }
    beatsPerBar = juce::jlimit (1, 16, beats);
    if (bpm <= 0.0 && detectedTempo.valid && downbeatOffsetSec >= 0.0)
    {
        bpm = detectedTempo.bpm;
        downbeatOffsetSec = detectedTempo.downbeatOffsetSec;
    }
    if (bpm > 0.0)
        bpmHint = bpm;
    startAnalysis (bpm, downbeatOffsetSec, beatsPerBar);
    return true;
}

bool Engine::setTrackRoute (int track, int bus, int role)
{
    if (song == nullptr || track < 0 || track >= (int) song->tracks.size())
    {
        setLastError ("La pista no existe.");
        return false;
    }
    trackBuses[(size_t) track] = bus == busMonitor ? busMonitor : busMain;
    trackRoles[(size_t) track] = juce::jlimit (0, 2, role);
    player.setTrackBus (track, trackBuses[(size_t) track]);
    mixPeaksDirty = true;
    updateBusTrims();
    return true;
}

void Engine::updateBusTrims()
{
    // Stems are often normalised one by one, so their sum can exceed 0 dBFS
    // (and clip). Lower each bus just enough for its peak to sit at -1 dBFS.
    // Pure gain: dynamics and tone are untouched. Never boosts.
    constexpr float target = 0.891f; // -1 dBFS
    auto trimFor = [&] (int bus) {
        const float peak = computeBusPeak (*song, trackBuses, bus);
        return peak > target ? target / peak : 1.0f;
    };
    mainTrim = trimFor (busMain);
    monitorTrim = trimFor (busMonitor);
    player.setBusTrims (mainTrim, monitorTrim);
}

bool Engine::setTrackGain (int track, float gain)
{
    if (song == nullptr || track < 0 || track >= (int) song->tracks.size())
    {
        setLastError ("La pista no existe.");
        return false;
    }
    player.setTrackGain (track, gain);
    return true;
}

bool Engine::setOutputMode (int mode)
{
    if (mode == 2 && player.getOutputChannels() < 4)
    {
        setLastError ("La salida actual solo tiene " + std::to_string (player.getOutputChannels())
                      + " canales: el modo de 4 canales necesita una interfaz con 4 salidas o más.");
        return false;
    }
    player.setOutputMode (mode);
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
            const size_t idx = (size_t) tracks.size();
            tr->setProperty ("role", juce::String (idx < trackRoles.size() ? (trackRoles[idx] == roleClick ? "click" : trackRoles[idx] == roleGuide ? "guide" : "music") : "music"));
            tr->setProperty ("bus", juce::String (idx < trackBuses.size() && trackBuses[idx] == busMonitor ? "monitor" : "main"));
            tracks.add (juce::var (tr));
        }
        s->setProperty ("tracks", tracks);
        s->setProperty ("beatsPerBar", beatsPerBar);
        s->setProperty ("mainTrimDb", 20.0 * std::log10 ((double) mainTrim));
        s->setProperty ("monitorTrimDb", 20.0 * std::log10 ((double) monitorTrim));
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
        if (mixPeaksDirty)
        {
            mixPeaks = computeMixPeaks (*song, trackRoles);
            mixPeaksDirty = false;
        }
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
