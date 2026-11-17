#pragma once

#include "Analysis.h"
#include "Player.h"
#include "SongLoader.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace liveplayer
{

/**
 * Engine root object: owns the audio device, the player, the background
 * song loader and the background analysis.
 *
 * Threading model:
 *  - Every public method runs on the control thread (application main
 *    thread), which is also JUCE's message thread.
 *  - Real-time audio lives in Player (lock-free); loading and analysis run on
 *    their own threads and are harvested by the control thread in
 *    getSongStatusJson().
 */
class Engine
{
public:
    Engine();
    ~Engine();

    Engine (const Engine&) = delete;
    Engine& operator= (const Engine&) = delete;

    juce::String describeAudioDevicesJson();
    /** Sample rates, buffer sizes and output channel names of one device. */
    juce::String describeDeviceJson (const juce::String& typeName, const juce::String& deviceName);

    bool openDefaultOutput();
    juce::String getOutputInfoJson();

    /** Device the user chose. sampleRate/bufferSize 0 = the device's default. */
    struct DeviceChoice
    {
        juce::String typeName, deviceName;
        double sampleRate = 0.0;
        int bufferSize = 0;
    };
    /** Opens (and remembers) a device. If it is not connected, the default
        output is used meanwhile and the choice is reopened when it comes back. */
    bool setAudioDevice (const DeviceChoice& choice);
    /** First device output (0-based) of the main and the monitor bus. */
    bool setOutputChannels (int mainFirst, int monitorFirst);
    /** 1 kHz line-check tone (-18 dBFS, 2 s) on one device output; -1 stops it. */
    bool startTestTone (int channel);
    /** Opens the driver's own settings window (ASIO). */
    bool showDeviceControlPanel();
    /** Device housekeeping (lost / reconnected device, sample-rate change).
        Called from the status getters, i.e. regularly on the control thread. */
    void maintainDevice();

    /** bpmHint > 0: the tempo is known (user); beatsPerBar: bar length for the grid. */
    bool loadSong (std::vector<TrackRequest> tracks, double bpmHint, int beatsPerBar);
    juce::String getSongStatusJson();
    bool getPeaks (int track, std::vector<juce::uint8>& out);
    /** downbeatOffsetSec < 0: estimate the bar grid for the given bpm. */
    bool detectSections (double bpm, double downbeatOffsetSec, int beatsPerBar);
    bool setTrackRoute (int track, int bus, int role);
    bool setTrackGain (int track, float gain);
    bool setOutputMode (int mode);

    Player& getPlayer() noexcept { return player; }
    bool hasSong() const noexcept { return song != nullptr; }

    struct TransportExtras
    {
        double audioLoad = 0.0;
        int deviceXruns = -1;
    };
    TransportExtras getTransportExtras();

    void setLastError (std::string message) { lastError = std::move (message); }
    const std::string& getLastError() const noexcept { return lastError; }

private:
    class AnalysisJob;

    void harvestLoader();
    void harvestAnalysis();
    void startAnalysis (double bpm, double downbeat, int beatsPerBar);
    void updateBusTrims();
    bool openDevice (const DeviceChoice& choice, juce::String& error);
    bool deviceListed (const juce::String& typeName, const juce::String& deviceName);
    void normaliseRouting();
    void startRateReload();
    void finishRateReload();
    void noteDeviceEvent (std::string message);

    juce::AudioDeviceManager deviceManager;
    Player player;
    bool callbackAttached = false;

    // Device choice and health.
    DeviceChoice preferred;
    bool hasPreferred = false;
    bool preferredWasListed = true;
    bool changingDevice = false;
    juce::String lastTypeName, lastDeviceName;
    int deviceEvents = 0;
    std::string lastDeviceEvent;
    juce::uint32 lastScanMs = 0;
    int mainFirst = 0, monitorFirst = 1, outputMode = 0;

    std::unique_ptr<SongLoader> loader;
    bool loaderIsReload = false; // re-decoding the same song for a new sample rate
    std::vector<TrackRequest> songRequests;
    std::vector<float> trackGains;
    double reloadPosition = 0.0, reloadTempo = 1.0;
    bool reloadPlaying = false;
    juce::uint64 nextLoadId = 1;
    juce::uint64 currentLoadId = 0;
    std::string loadState = "idle";
    std::string loadError;

    SongPtr song;
    std::vector<std::vector<juce::uint8>> trackPeaks;
    std::vector<juce::uint8> mixPeaks;
    bool mixPeaksDirty = false;
    std::vector<int> trackRoles; // current analysis role per track
    std::vector<int> trackBuses; // current output bus per track
    double pendingBpmHint = 0.0, bpmHint = 0.0;
    int pendingBeatsPerBar = 4, beatsPerBar = 4;
    float mainTrim = 1.0f, monitorTrim = 1.0f;

    std::unique_ptr<AnalysisJob> analysis;
    std::string analysisState = "pending";
    int analysisRevision = 0;
    analysis::Tempo detectedTempo;
    std::vector<analysis::Section> sections;

    std::string lastError;
};

} // namespace liveplayer
