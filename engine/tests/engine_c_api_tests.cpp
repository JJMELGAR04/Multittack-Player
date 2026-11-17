// Native tests for the public C ABI. Intentionally framework-free: the test
// binary only sees liveplayer_engine.h, exactly like any host would.

#include "liveplayer_engine.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static int failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::fprintf (stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            ++failures;                                                   \
        }                                                                 \
    } while (0)

static void testStaticInfo()
{
    CHECK (lp_engine_abi_version() == LP_ENGINE_ABI_VERSION);
    CHECK (std::strlen (lp_engine_version()) > 0);
    CHECK (std::strncmp (lp_engine_juce_version(), "9.", 2) == 0);
    const std::string build = lp_engine_build_type();
    CHECK (build == "Debug" || build == "Release");
}

static void testPing (lp_engine* e)
{
    int64_t out = 0;
    CHECK (lp_engine_ping (e, 41, &out) == LP_OK && out == 42);
    CHECK (lp_engine_ping (e, -1, &out) == LP_OK && out == 0);
    CHECK (lp_engine_ping (nullptr, 1, &out) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_ping (e, 1, nullptr) == LP_ERR_INVALID_ARGUMENT);
}

static void testDeviceDescription (lp_engine* e)
{
    size_t required = 0;
    CHECK (lp_engine_describe_audio_devices (e, nullptr, 0, &required) == LP_OK);
    CHECK (required > 2);

    char tiny[2];
    size_t again = 0;
    CHECK (lp_engine_describe_audio_devices (e, tiny, sizeof (tiny), &again) == LP_ERR_BUFFER_TOO_SMALL);

    std::vector<char> buf (required + 64);
    CHECK (lp_engine_describe_audio_devices (e, buf.data(), buf.size(), &required) == LP_OK);
    const std::string json (buf.data());
    CHECK (json.rfind ("{\"deviceTypes\":[", 0) == 0);
    std::printf ("audio devices: %s\n", json.c_str());

    CHECK (lp_engine_describe_audio_devices (e, nullptr, 0, nullptr) == LP_ERR_INVALID_ARGUMENT);
}

static void testTransportWithoutSong (lp_engine* e)
{
    // No song loaded: transport calls are rejected cleanly, never crash.
    CHECK (lp_engine_play (e) == LP_ERR_INVALID_STATE);
    CHECK (lp_engine_seek (e, 1.0) == LP_ERR_INVALID_STATE);
    CHECK (lp_engine_stop (e) == LP_ERR_INVALID_STATE);
    CHECK (lp_engine_detect_sections (e, 120.0, 0.0, 4) == LP_ERR_INVALID_STATE);
    CHECK (lp_engine_detect_sections (e, 120.0, 0.0, 0) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_track_route (e, 0, LP_BUS_MONITOR, LP_ROLE_CLICK) == LP_ERR_INVALID_STATE);
    CHECK (lp_engine_set_track_route (e, 0, 5, LP_ROLE_CLICK) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_track_gain (e, 0, 1.0) == LP_ERR_INVALID_STATE);
    CHECK (lp_engine_set_output_mode (e, 7) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_monitor_gain (e, 0.5) == LP_OK);
    size_t required = 0;
    CHECK (lp_engine_get_peaks (e, -1, nullptr, 0, &required) == LP_ERR_INVALID_STATE);

    // Argument validation.
    CHECK (lp_engine_set_tempo_ratio (e, 0.1) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_tempo_ratio (e, 3.0) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_master_gain (e, -1.0) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_seek (e, std::nan ("")) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_load_song (e, nullptr) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_load_song (e, "{\"tracks\":[]}") == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_load_song (e, "not json") == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_load_song (e, "{\"tracks\":[{\"path\":\"x.wav\"}],\"beatsPerBar\":40}") == LP_ERR_INVALID_ARGUMENT);

    lp_transport_state s {};
    CHECK (lp_engine_get_transport (e, &s) == LP_OK);
    CHECK (s.play_state == LP_STOPPED && s.duration_sec == 0.0 && s.underruns == 0);
    CHECK (lp_engine_get_transport (e, nullptr) == LP_ERR_INVALID_ARGUMENT);

    std::vector<char> buf (4096);
    CHECK (lp_engine_get_song_status (e, buf.data(), buf.size(), &required) == LP_OK);
    CHECK (std::string (buf.data()).find ("\"state\":\"idle\"") != std::string::npos);
}

int main()
{
    testStaticInfo();

    // Repeated create/destroy cycles must be clean.
    for (int cycle = 0; cycle < 3; ++cycle)
    {
        lp_engine* e = lp_engine_create();
        CHECK (e != nullptr);
        if (e == nullptr)
            break;
        testPing (e);
        if (cycle == 0)
            testDeviceDescription (e);
        CHECK (std::strcmp (lp_engine_last_error (e), "") == 0);
        if (cycle == 1)
            testTransportWithoutSong (e);
        lp_engine_destroy (e);
    }
    lp_engine_destroy (nullptr); // must be a no-op

    if (failures == 0)
        std::printf ("engine_c_api: all checks passed\n");
    return failures == 0 ? 0 : 1;
}
