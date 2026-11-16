// Implementation of the C ABI declared in include/liveplayer_engine.h.
// Every entry point catches all exceptions: nothing may unwind into the host.

#include "liveplayer_engine.h"
#include "Engine.h"

#include <cstring>
#include <exception>
#include <memory>

struct lp_engine
{
    liveplayer::Engine impl;
};

namespace
{
template <typename Fn>
lp_result guarded (lp_engine* engine, Fn&& fn) noexcept
{
    try
    {
        return fn();
    }
    catch (const std::exception& e)
    {
        if (engine != nullptr)
            engine->impl.setLastError (e.what());
    }
    catch (...)
    {
        if (engine != nullptr)
            engine->impl.setLastError ("unknown native exception");
    }
    return LP_ERR_INTERNAL;
}

int juceInitCount = 0; // guarded: create/destroy only on the control thread
} // namespace

extern "C" {

uint32_t lp_engine_abi_version (void) { return LP_ENGINE_ABI_VERSION; }

const char* lp_engine_version (void) { return LIVEPLAYER_ENGINE_VERSION; }

const char* lp_engine_juce_version (void)
{
    // Compile-time constants -> stable static string.
    static const std::string v = std::to_string (JUCE_MAJOR_VERSION) + "."
                               + std::to_string (JUCE_MINOR_VERSION) + "."
                               + std::to_string (JUCE_BUILDNUMBER);
    return v.c_str();
}

const char* lp_engine_build_type (void)
{
#if JUCE_DEBUG
    return "Debug";
#else
    return "Release";
#endif
}

lp_engine* lp_engine_create (void)
{
    try
    {
        // The calling thread becomes JUCE's message thread. In the Tauri host
        // this is the application's main thread, whose native event loop also
        // dispatches JUCE's internal messages.
        if (juceInitCount++ == 0)
            juce::MessageManager::getInstance();

        return new lp_engine{};
    }
    catch (...)
    {
        return nullptr;
    }
}

void lp_engine_destroy (lp_engine* engine)
{
    if (engine == nullptr)
        return;

    try
    {
        delete engine;
        if (--juceInitCount == 0)
        {
            juce::DeletedAtShutdown::deleteAll();
            juce::MessageManager::deleteInstance();
        }
    }
    catch (...)
    {
    }
}

const char* lp_engine_last_error (const lp_engine* engine)
{
    if (engine == nullptr)
        return "";
    return engine->impl.getLastError().c_str();
}

lp_result lp_engine_ping (lp_engine* engine, int64_t value, int64_t* out_value)
{
    if (engine == nullptr || out_value == nullptr)
        return LP_ERR_INVALID_ARGUMENT;

    return guarded (engine, [&] {
        *out_value = value + 1;
        return LP_OK;
    });
}

lp_result lp_engine_describe_audio_devices (lp_engine* engine,
                                            char* buffer,
                                            size_t capacity,
                                            size_t* out_required)
{
    if (engine == nullptr || out_required == nullptr || (buffer == nullptr && capacity != 0))
        return LP_ERR_INVALID_ARGUMENT;

    return guarded (engine, [&] {
        const auto json = engine->impl.describeAudioDevicesJson().toStdString();
        *out_required = json.size() + 1;

        if (buffer == nullptr || capacity < json.size() + 1)
            return buffer == nullptr ? LP_OK : LP_ERR_BUFFER_TOO_SMALL;

        std::memcpy (buffer, json.c_str(), json.size() + 1);
        return LP_OK;
    });
}

} // extern "C"
