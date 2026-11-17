#include "Engine.h"

#include <cmath>

namespace
{
constexpr int maxOutputChannels = 32;

juce::String toJson (const juce::var& v)
{
    return juce::JSON::toString (v, juce::JSON::FormatOptions{}.withSpacing (juce::JSON::Spacing::none));
}

juce::var toVarArray (const juce::StringArray& items)
{
    juce::Array<juce::var> a;
    for (const auto& s : items)
        a.add (s);
    return a;
}
} // namespace

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
    preloader.reset();
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
    root->setProperty ("asioSupported", LIVEPLAYER_WITH_ASIO != 0);
    return toJson (juce::var (root));
}

juce::String Engine::describeDeviceJson (const juce::String& typeName, const juce::String& deviceName)
{
    auto* root = new juce::DynamicObject();
    root->setProperty ("typeName", typeName);
    root->setProperty ("deviceName", deviceName);

    auto describe = [&] (juce::AudioIODevice& d) {
        juce::Array<juce::var> rates, sizes;
        for (auto r : d.getAvailableSampleRates())
            rates.add (r);
        for (auto b : d.getAvailableBufferSizes())
            sizes.add (b);
        root->setProperty ("available", true);
        root->setProperty ("sampleRates", rates);
        root->setProperty ("bufferSizes", sizes);
        root->setProperty ("defaultBufferSize", d.getDefaultBufferSize());
        root->setProperty ("outputChannelNames", toVarArray (d.getOutputChannelNames()));
        root->setProperty ("hasControlPanel", d.hasControlPanel());
    };

    // The open device is described directly (an ASIO driver can only be loaded once).
    auto* current = deviceManager.getCurrentAudioDevice();
    if (current != nullptr && current->getTypeName() == typeName && current->getName() == deviceName)
    {
        describe (*current);
        return toJson (juce::var (root));
    }

    root->setProperty ("available", false);
    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        if (type->getTypeName() != typeName)
            continue;
        type->scanForDevices();
        if (! type->getDeviceNames (false).contains (deviceName))
            break;
        std::unique_ptr<juce::AudioIODevice> device (type->createDevice (deviceName, {}));
        if (device != nullptr)
            describe (*device);
        break;
    }
    return toJson (juce::var (root));
}

bool Engine::deviceListed (const juce::String& typeName, const juce::String& deviceName)
{
    for (auto* type : deviceManager.getAvailableDeviceTypes())
        if (type->getTypeName() == typeName)
        {
            type->scanForDevices();
            return type->getDeviceNames (false).contains (deviceName);
        }
    return false;
}

bool Engine::openDevice (const DeviceChoice& choice, juce::String& error)
{
    const juce::ScopedValueSetter<bool> busy (changingDevice, true);
    deviceManager.setCurrentAudioDeviceType (choice.typeName, true);
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = choice.deviceName;
    setup.inputDeviceName = {};
    setup.sampleRate = choice.sampleRate;
    setup.bufferSize = choice.bufferSize;
    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    setup.useDefaultOutputChannels = false;
    setup.outputChannels.clear();
    setup.outputChannels.setRange (0, maxOutputChannels, true); // every output the device has
    error = deviceManager.setAudioDeviceSetup (setup, true);
    if (error.isEmpty() && deviceManager.getCurrentAudioDevice() == nullptr)
        error = "el dispositivo no se pudo abrir";
    if (error.isEmpty() && ! callbackAttached)
    {
        deviceManager.addAudioCallback (&player);
        callbackAttached = true;
    }
    return error.isEmpty();
}

bool Engine::setAudioDevice (const DeviceChoice& choice)
{
    if (choice.typeName.isEmpty() || choice.deviceName.isEmpty())
    {
        setLastError ("Elige un tipo de controlador y un dispositivo.");
        return false;
    }
    bool knownType = false;
    for (auto* type : deviceManager.getAvailableDeviceTypes())
        knownType = knownType || type->getTypeName() == choice.typeName;
    if (! knownType)
    {
        setLastError ("El tipo de controlador \xc2\xab" + choice.typeName.toStdString() + "\xc2\xbb no está disponible en este equipo.");
        return false;
    }

    // Remembered even when not connected: it is reopened when it appears.
    preferred = choice;
    hasPreferred = true;
    preferredWasListed = deviceListed (choice.typeName, choice.deviceName);
    if (! preferredWasListed)
    {
        noteDeviceEvent ("\xc2\xab" + choice.deviceName.toStdString() + "\xc2\xbb no está conectado: se usa la salida por defecto hasta que se conecte.");
        if (deviceManager.getCurrentAudioDevice() == nullptr)
            openDefaultOutput();
        auto* d = deviceManager.getCurrentAudioDevice();
        lastTypeName = d != nullptr ? d->getTypeName() : juce::String();
        lastDeviceName = d != nullptr ? d->getName() : juce::String();
        normaliseRouting();
        return true;
    }

    // Keep what was playing, in case the new device refuses to open.
    auto* previous = deviceManager.getCurrentAudioDevice();
    DeviceChoice before;
    if (previous != nullptr)
    {
        before.typeName = previous->getTypeName();
        before.deviceName = previous->getName();
        before.sampleRate = previous->getCurrentSampleRate();
        before.bufferSize = previous->getCurrentBufferSizeSamples();
    }

    juce::String error;
    if (! openDevice (choice, error))
    {
        juce::String ignored;
        if (before.deviceName.isNotEmpty())
            openDevice (before, ignored);
        else
            openDefaultOutput();
        setLastError ("No se pudo abrir \xc2\xab" + choice.deviceName.toStdString() + "\xc2\xbb: " + error.toStdString());
        if (auto* d = deviceManager.getCurrentAudioDevice())
        {
            lastTypeName = d->getTypeName();
            lastDeviceName = d->getName();
        }
        return false;
    }

    auto* d = deviceManager.getCurrentAudioDevice();
    lastTypeName = d->getTypeName();
    lastDeviceName = d->getName();
    normaliseRouting();
    maintainDevice(); // sample-rate change -> re-decode the song
    return true;
}

void Engine::normaliseRouting()
{
    // Keeps the bus outputs inside the device; falls back to the usual layout.
    const int n = juce::jmax (1, player.getOutputChannels());
    auto fits = [&] (int mode, int m, int s) {
        if (mode == 0)
            return m + 1 < n || (n == 1 && m == 0);
        if (mode == 1)
            return m < n && s < n && m != s;
        return m + 1 < n && s + 1 < n && (m + 1 < s || s + 1 < m);
    };
    if (! fits (outputMode, mainFirst, monitorFirst))
    {
        mainFirst = 0;
        monitorFirst = outputMode == 2 ? 2 : 1;
        if (! fits (outputMode, mainFirst, monitorFirst))
        {
            outputMode = 0;
            monitorFirst = 1;
            player.setOutputMode (0);
        }
    }
    player.setOutputChannels (mainFirst, monitorFirst);
}

bool Engine::setOutputChannels (int mainCh, int monitorCh)
{
    const int n = juce::jmax (1, player.getOutputChannels());
    if (mainCh < 0 || monitorCh < 0 || mainCh >= n || monitorCh >= n)
    {
        setLastError ("La salida elegida no existe: este dispositivo tiene " + std::to_string (n) + " salidas.");
        return false;
    }
    if (outputMode == 1 && mainCh == monitorCh)
    {
        setLastError ("La banda y el click deben ir por salidas distintas.");
        return false;
    }
    if (outputMode == 2 && (mainCh + 1 >= n || monitorCh + 1 >= n || ! (mainCh + 1 < monitorCh || monitorCh + 1 < mainCh)))
    {
        setLastError ("En el modo de 4 canales cada bus necesita un par de salidas propio.");
        return false;
    }
    if (outputMode == 0 && n > 1 && mainCh + 1 >= n)
    {
        setLastError ("En estéreo se usan dos salidas seguidas: elige una que tenga otra a su derecha.");
        return false;
    }
    mainFirst = mainCh;
    monitorFirst = monitorCh;
    player.setOutputChannels (mainFirst, monitorFirst);
    return true;
}

bool Engine::startTestTone (int channel)
{
    if (! openDefaultOutput())
        return false;
    if (channel >= player.getOutputChannels())
    {
        setLastError ("La salida " + std::to_string (channel + 1) + " no existe en este dispositivo.");
        return false;
    }
    player.startTestTone (channel);
    return true;
}

bool Engine::showDeviceControlPanel()
{
    auto* d = deviceManager.getCurrentAudioDevice();
    if (d == nullptr || ! d->hasControlPanel())
    {
        setLastError ("Este dispositivo no tiene panel de control propio.");
        return false;
    }
    const juce::ScopedValueSetter<bool> busy (changingDevice, true);
    if (d->showControlPanel())
    {
        // The driver changed its settings (e.g. ASIO buffer): reopen it.
        juce::String error;
        DeviceChoice c { d->getTypeName(), d->getName(), d->getCurrentSampleRate(), 0 };
        openDevice (c, error);
    }
    return true;
}

void Engine::noteDeviceEvent (std::string message)
{
    ++deviceEvents;
    lastDeviceEvent = std::move (message);
}

void Engine::maintainDevice()
{
    auto* d = deviceManager.getCurrentAudioDevice();
    const juce::String type = d != nullptr ? d->getTypeName() : juce::String();
    const juce::String name = d != nullptr ? d->getName() : juce::String();

    // An output change we did not ask for = the device was lost (unplugged,
    // taken by another app, driver reset). JUCE falls back to the default one.
    if (! changingDevice && lastDeviceName.isNotEmpty() && (type != lastTypeName || name != lastDeviceName))
    {
        noteDeviceEvent (d != nullptr
                             ? "Se perdió \xc2\xab" + lastDeviceName.toStdString() + "\xc2\xbb. Sonando por \xc2\xab" + name.toStdString() + "\xc2\xbb."
                             : "Se perdió \xc2\xab" + lastDeviceName.toStdString() + "\xc2\xbb. No hay salida de audio.");
        normaliseRouting();
    }
    lastTypeName = type;
    lastDeviceName = name;

    const auto now = juce::Time::getMillisecondCounter();
    if (now - lastScanMs >= 1500)
    {
        lastScanMs = now;

        // The open device vanished and nobody closed it: fall back ourselves.
        if (d != nullptr && ! deviceListed (type, name))
        {
            const juce::ScopedValueSetter<bool> busy (changingDevice, true);
            deviceManager.closeAudioDevice();
            noteDeviceEvent ("Se perdió \xc2\xab" + name.toStdString() + "\xc2\xbb.");
            d = nullptr;
        }

        if (hasPreferred && ! (type == preferred.typeName && name == preferred.deviceName))
        {
            const bool listed = deviceListed (preferred.typeName, preferred.deviceName);
            if (listed && ! preferredWasListed)
            {
                juce::String error;
                if (openDevice (preferred, error))
                {
                    noteDeviceEvent ("Se reconectó \xc2\xab" + preferred.deviceName.toStdString() + "\xc2\xbb.");
                    normaliseRouting();
                }
            }
            preferredWasListed = listed;
        }

        if (deviceManager.getCurrentAudioDevice() == nullptr)
        {
            const juce::ScopedValueSetter<bool> busy (changingDevice, true);
            if (openDefaultOutput())
                normaliseRouting();
        }
        d = deviceManager.getCurrentAudioDevice();
        lastTypeName = d != nullptr ? d->getTypeName() : juce::String();
        lastDeviceName = d != nullptr ? d->getName() : juce::String();
    }

    // New sample rate: the song is decoded again at that rate (the position,
    // tempo, mix and detected parts are kept).
    if (song != nullptr && loader == nullptr && d != nullptr && std::abs (d->getCurrentSampleRate() - song->sampleRate) > 0.5)
        startRateReload();
}

void Engine::startRateReload()
{
    const auto snap = player.snapshot();
    reloadPosition = snap.positionSec;
    reloadPlaying = snap.playState == 1;
    reloadTempo = player.getTempoTarget();
    for (size_t i = 0; i < songRequests.size() && i < trackRoles.size(); ++i)
    {
        songRequests[i].role = trackRoles[i];
        songRequests[i].bus = trackBuses[i];
    }
    loaderIsReload = true;
    loader = std::make_unique<SongLoader> (songRequests, deviceManager.getCurrentAudioDevice()->getCurrentSampleRate(), currentLoadId);
    loader->startThread();
}


bool Engine::openDefaultOutput()
{
    if (deviceManager.getCurrentAudioDevice() != nullptr)
        return true;

    // Every output of the device (the user picks which ones the buses use).
    const auto err = deviceManager.initialiseWithDefaultDevices (0, maxOutputChannels);
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
    maintainDevice();
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
        root->setProperty ("outputChannelNames", toVarArray (device->getOutputChannelNames()));
        juce::Array<juce::var> rates, sizes;
        for (auto r : device->getAvailableSampleRates())
            rates.add (r);
        for (auto b : device->getAvailableBufferSizes())
            sizes.add (b);
        root->setProperty ("sampleRates", rates);
        root->setProperty ("bufferSizes", sizes);
        root->setProperty ("hasControlPanel", device->hasControlPanel());
        root->setProperty ("xruns", device->getXRunCount());
    }
    root->setProperty ("cpuLoad", deviceManager.getCpuUsage());
    root->setProperty ("underruns", (juce::int64) player.snapshot().underruns);
    root->setProperty ("mainChannel", mainFirst);
    root->setProperty ("monitorChannel", monitorFirst);
    root->setProperty ("outputMode", outputMode);
    root->setProperty ("asioSupported", LIVEPLAYER_WITH_ASIO != 0);
    root->setProperty ("reloading", loader != nullptr && loaderIsReload);
    root->setProperty ("deviceEvents", deviceEvents);
    root->setProperty ("lastDeviceEvent", juce::String::fromUTF8 (lastDeviceEvent.c_str()));
    if (hasPreferred)
    {
        auto* p = new juce::DynamicObject();
        p->setProperty ("typeName", preferred.typeName);
        p->setProperty ("deviceName", preferred.deviceName);
        p->setProperty ("sampleRate", preferred.sampleRate);
        p->setProperty ("bufferSize", preferred.bufferSize);
        root->setProperty ("preferred", juce::var (p));
        root->setProperty ("usingPreferred", device != nullptr && device->getTypeName() == preferred.typeName && device->getName() == preferred.deviceName);
    }
    return toJson (juce::var (root));
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
    loaderIsReload = false;
    harvestPreload();
    const double deviceRate = deviceManager.getCurrentAudioDevice()->getCurrentSampleRate();
    if (preloadedSong != nullptr && preloadRequests == tracks && std::abs (preloadedSong->sampleRate - deviceRate) < 0.5)
    {
        // Decoded in advance: installed right away, no waiting between songs.
        songRequests = tracks;
        pendingBpmHint = bpm > 0.0 ? bpm : 0.0;
        pendingBeatsPerBar = juce::jlimit (1, 16, beats);
        currentLoadId = nextLoadId++;
        loadError.clear();
        auto ready = std::move (preloadedSong);
        auto peaks = std::move (preloadedPeaks);
        auto mix = std::move (preloadedMix);
        preloadedSong = nullptr;
        preloadRequests.clear();
        preloadState = "idle";
        installSong (std::move (ready), std::move (peaks), std::move (mix));
        return true;
    }
    songRequests = tracks;
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
            if (loaderIsReload)
            {
                // The song stays installed (silent until the rate matches again).
                setLastError ("No se pudo adaptar la canción a la nueva frecuencia: " + loader->getError());
                loaderIsReload = false;
                loader.reset();
                return;
            }
            loadState = "error";
            loadError = loader->getError();
            loader.reset();
            return;

        case SongLoader::Phase::ready:
        {
            if (loaderIsReload)
            {
                finishRateReload();
                return;
            }
            auto newSong = loader->getSong();
            auto peaks = loader->takeTrackPeaks();
            auto mix = loader->takeMixPeaks();
            loader.reset();
            installSong (std::move (newSong), std::move (peaks), std::move (mix));
            return;
        }
    }
}

bool Engine::preloadSong (std::vector<TrackRequest> tracks)
{
    preloader.reset();
    if (tracks.empty())
    {
        preloadedSong = nullptr;
        preloadedPeaks.clear();
        preloadedMix.clear();
        preloadRequests.clear();
        preloadState = "idle";
        return true;
    }
    if (! openDefaultOutput())
        return false;
    if (tracks == preloadRequests && (preloadedSong != nullptr || preloader != nullptr))
        return true;
    if (tracks == songRequests && song != nullptr)
        return true; // already the current song
    preloadedSong = nullptr;
    preloadRequests = tracks;
    preloadState = "loading";
    preloader = std::make_unique<SongLoader> (std::move (tracks), deviceManager.getCurrentAudioDevice()->getCurrentSampleRate(), 0);
    // Low priority: decoding must never compete with the song that is playing.
    preloader->startThread (juce::Thread::Priority::low);
    return true;
}

void Engine::harvestPreload()
{
    if (preloader == nullptr)
        return;
    const auto phase = preloader->getPhase();
    if (phase == SongLoader::Phase::loading)
        return;
    if (phase == SongLoader::Phase::failed)
    {
        preloadState = "error";
        preloader.reset();
        return;
    }
    auto next = preloader->getSong();
    preloadedPeaks = preloader->takeTrackPeaks();
    preloadedMix = preloader->takeMixPeaks();
    preloader.reset();

    // Keep it only if both songs fit comfortably in RAM.
    const double totalMB = (double) juce::SystemStats::getMemorySizeInMegabytes();
    const double needMB = (double) (next->memoryBytes() + (song != nullptr ? song->memoryBytes() : 0)) / (1024.0 * 1024.0);
    if (totalMB > 0 && needMB > 0.5 * totalMB)
    {
        preloadedPeaks.clear();
        preloadedMix.clear();
        preloadState = "skipped";
        return;
    }
    preloadedSong = std::move (next);
    preloadState = "ready";
}

void Engine::installSong (SongPtr newSong, std::vector<std::vector<juce::uint8>> peaks, std::vector<juce::uint8> mix)
{
    analysis.reset();
    trackPeaks = std::move (peaks);
    mixPeaks = std::move (mix);

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
    trackGains.assign (song->tracks.size(), 1.0f);
    updateBusTrims();
    bpmHint = pendingBpmHint;
    beatsPerBar = pendingBeatsPerBar;
    loadState = "ready";
    detectedTempo = {};
    sections.clear();
    startAnalysis (bpmHint, -1.0, beatsPerBar);
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
    trackGains[(size_t) track] = gain;
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
    if (mode == 1 && player.getOutputChannels() < 2)
    {
        setLastError ("El modo dividido necesita al menos 2 salidas.");
        return false;
    }
    outputMode = juce::jlimit (0, 2, mode);
    player.setOutputMode (outputMode);
    normaliseRouting();
    return true;
}

void Engine::finishRateReload()
{
    auto newSong = loader->getSong();
    trackPeaks = loader->takeTrackPeaks();
    mixPeaks = loader->takeMixPeaks();
    loader.reset();
    loaderIsReload = false;

    if (callbackAttached)
        deviceManager.removeAudioCallback (&player);
    player.setSong (newSong);
    for (size_t t = 0; t < trackBuses.size(); ++t)
        player.setTrackBus ((int) t, trackBuses[t]);
    for (size_t t = 0; t < trackGains.size(); ++t)
        player.setTrackGain ((int) t, trackGains[t]);
    player.setTempoRatio (reloadTempo);
    if (callbackAttached)
        deviceManager.addAudioCallback (&player);

    song = std::move (newSong);
    mixPeaksDirty = true;
    updateBusTrims();
    player.seek (reloadPosition);
    if (reloadPlaying)
        player.play();
}

juce::String Engine::getSongStatusJson()
{
    maintainDevice();
    harvestLoader();
    harvestPreload();
    harvestAnalysis();

    auto* root = new juce::DynamicObject();
    root->setProperty ("state", juce::String (loadState));
    root->setProperty ("progress", loader != nullptr ? (double) loader->getProgress() : (loadState == "ready" ? 1.0 : 0.0));
    root->setProperty ("error", juce::String (loadError));
    root->setProperty ("loadId", (juce::int64) currentLoadId);
    {
        auto* p = new juce::DynamicObject();
        p->setProperty ("state", juce::String (preloadState));
        p->setProperty ("tracks", (int) preloadRequests.size());
        if (preloadedSong != nullptr)
            p->setProperty ("memoryMB", (double) preloadedSong->memoryBytes() / (1024.0 * 1024.0));
        root->setProperty ("preload", juce::var (p));
    }

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
