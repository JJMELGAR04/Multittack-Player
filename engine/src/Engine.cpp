#include "Engine.h"

namespace liveplayer
{

Engine::Engine() = default;

Engine::~Engine()
{
    deviceManager.closeAudioDevice();
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

} // namespace liveplayer
