#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>

#include <string>

namespace liveplayer
{

/**
 * Engine root object. In phase 1 it only owns the JUCE audio device manager
 * (no device is opened) and offers diagnostics. Playback, the shared clock,
 * mixing and routing are added in later phases on top of this object.
 *
 * Threading model:
 *  - Constructed/destroyed on the control thread (application main thread),
 *    which also acts as JUCE's message thread.
 *  - The real-time audio callback (phase 2+) will never lock, allocate or do
 *    I/O; it communicates with the control thread via lock-free structures.
 */
class Engine
{
public:
    Engine();
    ~Engine();

    Engine (const Engine&) = delete;
    Engine& operator= (const Engine&) = delete;

    /** JSON description of available audio back-ends and output devices. */
    juce::String describeAudioDevicesJson();

    void setLastError (std::string message) { lastError = std::move (message); }
    const std::string& getLastError() const noexcept { return lastError; }

private:
    juce::AudioDeviceManager deviceManager;
    std::string lastError;
};

} // namespace liveplayer
