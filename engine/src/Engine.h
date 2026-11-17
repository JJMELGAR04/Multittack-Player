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

    bool openDefaultOutput();
    juce::String getOutputInfoJson();

    bool loadSong (std::vector<TrackRequest> tracks);
    juce::String getSongStatusJson();
    bool getPeaks (int track, std::vector<juce::uint8>& out);
    bool detectSections (double bpm, double downbeatOffsetSec);

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
    void startAnalysis (double bpmOverride, double downbeatOverride);

    juce::AudioDeviceManager deviceManager;
    Player player;
    bool callbackAttached = false;

    std::unique_ptr<SongLoader> loader;
    juce::uint64 nextLoadId = 1;
    juce::uint64 currentLoadId = 0;
    std::string loadState = "idle";
    std::string loadError;

    SongPtr song;
    std::vector<std::vector<juce::uint8>> trackPeaks;
    std::vector<juce::uint8> mixPeaks;

    std::unique_ptr<AnalysisJob> analysis;
    std::string analysisState = "pending";
    int analysisRevision = 0;
    analysis::Tempo detectedTempo;
    std::vector<analysis::Section> sections;

    std::string lastError;
};

} // namespace liveplayer
