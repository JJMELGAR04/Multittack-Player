// Implementation of the C ABI declared in include/liveplayer_engine.h.
// Every entry point catches all exceptions: nothing may unwind into the host.

#include "liveplayer_engine.h"
#include "Engine.h"

#include <cmath>
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

/** Two-call pattern helper for byte/string results. */
lp_result writeOut (const void* data, size_t size, void* buffer, size_t capacity, size_t* outRequired)
{
    *outRequired = size;
    if (buffer == nullptr)
        return LP_OK;
    if (capacity < size)
        return LP_ERR_BUFFER_TOO_SMALL;
    if (size > 0)
        std::memcpy (buffer, data, size);
    return LP_OK;
}

lp_result writeJson (const juce::String& json, char* buffer, size_t capacity, size_t* outRequired)
{
    const auto utf8 = json.toStdString();
    return writeOut (utf8.c_str(), utf8.size() + 1, buffer, capacity, outRequired);
}

bool validBuffer (const void* buffer, size_t capacity, const size_t* outRequired)
{
    return outRequired != nullptr && (buffer != nullptr || capacity == 0);
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

lp_result lp_engine_describe_audio_devices (lp_engine* engine, char* buffer, size_t capacity, size_t* out_required)
{
    if (engine == nullptr || ! validBuffer (buffer, capacity, out_required))
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return writeJson (engine->impl.describeAudioDevicesJson(), buffer, capacity, out_required); });
}

lp_result lp_engine_open_default_output (lp_engine* engine)
{
    if (engine == nullptr)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return engine->impl.openDefaultOutput() ? LP_OK : LP_ERR_INTERNAL; });
}

lp_result lp_engine_get_output_info (lp_engine* engine, char* buffer, size_t capacity, size_t* out_required)
{
    if (engine == nullptr || ! validBuffer (buffer, capacity, out_required))
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return writeJson (engine->impl.getOutputInfoJson(), buffer, capacity, out_required); });
}

lp_result lp_engine_load_song (lp_engine* engine, const char* request_json)
{
    if (engine == nullptr || request_json == nullptr)
        return LP_ERR_INVALID_ARGUMENT;

    return guarded (engine, [&] {
        const auto parsed = juce::JSON::parse (juce::String::fromUTF8 (request_json));
        const auto* tracks = parsed.getProperty ("tracks", {}).getArray();
        if (tracks == nullptr || tracks->isEmpty())
        {
            engine->impl.setLastError ("Solicitud inválida: se esperaba {\"tracks\":[...]}");
            return LP_ERR_INVALID_ARGUMENT;
        }

        std::vector<liveplayer::TrackRequest> requests;
        for (const auto& t : *tracks)
        {
            liveplayer::TrackRequest r;
            r.path = t.getProperty ("path", {}).toString().toStdString();
            r.name = t.getProperty ("name", {}).toString().toStdString();
            const auto role = t.getProperty ("role", {}).toString();
            if (role == "click") r.role = liveplayer::roleClick;
            else if (role == "guide") r.role = liveplayer::roleGuide;
            else if (role == "music") r.role = liveplayer::roleMusic;
            const auto bus = t.getProperty ("bus", {}).toString();
            if (bus == "monitor") r.bus = liveplayer::busMonitor;
            else if (bus == "main") r.bus = liveplayer::busMain;
            if (r.path.empty())
            {
                engine->impl.setLastError ("Solicitud inválida: pista sin \"path\"");
                return LP_ERR_INVALID_ARGUMENT;
            }
            requests.push_back (std::move (r));
        }
        const double bpm = parsed.getProperty ("bpm", 0.0);
        const int beats = parsed.getProperty ("beatsPerBar", 4);
        if (! std::isfinite (bpm) || bpm < 0.0 || bpm > 400.0 || beats < 1 || beats > 16)
        {
            engine->impl.setLastError ("Solicitud inválida: bpm o beatsPerBar fuera de rango");
            return LP_ERR_INVALID_ARGUMENT;
        }
        return engine->impl.loadSong (std::move (requests), bpm, beats) ? LP_OK : LP_ERR_INTERNAL;
    });
}

lp_result lp_engine_get_song_status (lp_engine* engine, char* buffer, size_t capacity, size_t* out_required)
{
    if (engine == nullptr || ! validBuffer (buffer, capacity, out_required))
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return writeJson (engine->impl.getSongStatusJson(), buffer, capacity, out_required); });
}

lp_result lp_engine_get_peaks (lp_engine* engine, int32_t track, uint8_t* buffer, size_t capacity, size_t* out_required)
{
    if (engine == nullptr || ! validBuffer (buffer, capacity, out_required))
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        std::vector<juce::uint8> peaks;
        if (! engine->impl.getPeaks (track, peaks))
        {
            engine->impl.setLastError ("No hay canción cargada o la pista no existe.");
            return LP_ERR_INVALID_STATE;
        }
        return writeOut (peaks.data(), peaks.size(), buffer, capacity, out_required);
    });
}

lp_result lp_engine_detect_sections (lp_engine* engine, double bpm, double downbeat_offset_sec, int32_t beats_per_bar)
{
    if (engine == nullptr || ! std::isfinite (bpm) || ! std::isfinite (downbeat_offset_sec) || bpm > 400.0
        || beats_per_bar < 1 || beats_per_bar > 16)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return engine->impl.detectSections (bpm, downbeat_offset_sec, beats_per_bar) ? LP_OK : LP_ERR_INVALID_STATE; });
}

lp_result lp_engine_set_track_route (lp_engine* engine, int32_t track, int32_t bus, int32_t role)
{
    if (engine == nullptr || bus < 0 || bus > 1 || role < 0 || role > 2)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return engine->impl.setTrackRoute (track, bus, role) ? LP_OK : LP_ERR_INVALID_STATE; });
}

lp_result lp_engine_set_track_gain (lp_engine* engine, int32_t track, double gain)
{
    if (engine == nullptr || ! std::isfinite (gain) || gain < 0.0 || gain > 2.0)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return engine->impl.setTrackGain (track, (float) gain) ? LP_OK : LP_ERR_INVALID_STATE; });
}

lp_result lp_engine_set_output_mode (lp_engine* engine, int32_t mode)
{
    if (engine == nullptr || mode < 0 || mode > 2)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] { return engine->impl.setOutputMode (mode) ? LP_OK : LP_ERR_INVALID_STATE; });
}

lp_result lp_engine_set_monitor_gain (lp_engine* engine, double gain)
{
    if (engine == nullptr || ! std::isfinite (gain) || gain < 0.0 || gain > 2.0)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        engine->impl.getPlayer().setMonitorGain ((float) gain);
        return LP_OK;
    });
}

#define LP_REQUIRE_SONG(engine)                                           \
    if (! (engine)->impl.hasSong())                                       \
    {                                                                     \
        (engine)->impl.setLastError ("No hay ninguna canción cargada.");  \
        return LP_ERR_INVALID_STATE;                                      \
    }

lp_result lp_engine_play (lp_engine* engine)
{
    if (engine == nullptr)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        LP_REQUIRE_SONG (engine);
        engine->impl.getPlayer().play();
        return LP_OK;
    });
}

lp_result lp_engine_pause (lp_engine* engine)
{
    if (engine == nullptr)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        LP_REQUIRE_SONG (engine);
        engine->impl.getPlayer().pause();
        return LP_OK;
    });
}

lp_result lp_engine_stop (lp_engine* engine)
{
    if (engine == nullptr)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        LP_REQUIRE_SONG (engine);
        engine->impl.getPlayer().stop();
        return LP_OK;
    });
}

lp_result lp_engine_seek (lp_engine* engine, double position_sec)
{
    if (engine == nullptr || ! std::isfinite (position_sec))
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        LP_REQUIRE_SONG (engine);
        engine->impl.getPlayer().seek (position_sec);
        return LP_OK;
    });
}

lp_result lp_engine_set_master_gain (lp_engine* engine, double gain)
{
    if (engine == nullptr || ! std::isfinite (gain) || gain < 0.0 || gain > 2.0)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        engine->impl.getPlayer().setMasterGain ((float) gain);
        return LP_OK;
    });
}

lp_result lp_engine_set_tempo_ratio (lp_engine* engine, double ratio)
{
    if (engine == nullptr || ! std::isfinite (ratio) || ratio < 0.5 || ratio > 2.0)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        engine->impl.getPlayer().setTempoRatio (ratio);
        return LP_OK;
    });
}

lp_result lp_engine_get_transport (lp_engine* engine, lp_transport_state* out_state)
{
    if (engine == nullptr || out_state == nullptr)
        return LP_ERR_INVALID_ARGUMENT;
    return guarded (engine, [&] {
        const auto s = engine->impl.getPlayer().snapshot();
        const auto extras = engine->impl.getTransportExtras();
        *out_state = {};
        out_state->play_state = s.playState;
        out_state->ended = s.ended ? 1 : 0;
        out_state->stretching = s.stretching ? 1 : 0;
        out_state->device_xruns = extras.deviceXruns;
        out_state->position_sec = s.positionSec;
        out_state->duration_sec = s.durationSec;
        out_state->tempo_ratio = s.tempoRatio;
        out_state->master_gain = s.masterGain;
        out_state->audio_load = extras.audioLoad;
        out_state->render_load = s.renderLoad;
        out_state->underruns = s.underruns;
        out_state->output_mode = s.outputMode;
        out_state->output_channels = s.outputChannels;
        out_state->monitor_gain = s.monitorGain;
        out_state->main_limiter_gain = s.mainLimiterGain;
        out_state->monitor_limiter_gain = s.monitorLimiterGain;
        return LP_OK;
    });
}

} // extern "C"
