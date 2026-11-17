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

static std::string outputInfo (lp_engine* e)
{
    size_t required = 0;
    lp_engine_get_output_info (e, nullptr, 0, &required);
    std::vector<char> buf (required + 256);
    CHECK (lp_engine_get_output_info (e, buf.data(), buf.size(), &required) == LP_OK);
    return std::string (buf.data());
}

static std::string jsonString (const std::string& json, const std::string& key)
{
    const auto k = json.find ("\"" + key + "\":\"");
    if (k == std::string::npos)
        return {};
    const auto start = k + key.size() + 4;
    std::string out;
    for (size_t i = start; i < json.size() && json[i] != '"'; ++i)
    {
        if (json[i] == '\\' && i + 1 < json.size())
            ++i;
        out += json[i];
    }
    return out;
}

static void testDeviceSelection (lp_engine* e)
{
    // Unknown driver type: rejected.
    CHECK (lp_engine_set_audio_device (e, "{\"typeName\":\"Nope\",\"deviceName\":\"X\"}") == LP_ERR_INTERNAL);
    CHECK (lp_engine_set_audio_device (e, "{\"typeName\":\"Windows Audio\"}") == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_audio_device (e, nullptr) == LP_ERR_INVALID_ARGUMENT);

    // A device that is not connected is remembered; the default output plays meanwhile.
    CHECK (lp_engine_set_audio_device (e, "{\"typeName\":\"Windows Audio\",\"deviceName\":\"LIVEPLAYER Missing Interface\",\"sampleRate\":48000}") == LP_OK);
    auto info = outputInfo (e);
    std::printf ("missing device -> %s\n", info.c_str());
    CHECK (info.find ("\"usingPreferred\":false") != std::string::npos);
    CHECK (info.find ("LIVEPLAYER Missing Interface") != std::string::npos);
    CHECK (info.find ("\"deviceEvents\":0") == std::string::npos);

    std::vector<char> buf (8192);
    size_t required = 0;
    CHECK (lp_engine_describe_device (e, "{\"typeName\":\"Windows Audio\",\"deviceName\":\"LIVEPLAYER Missing Interface\"}", buf.data(), buf.size(), &required) == LP_OK);
    CHECK (std::string (buf.data()).find ("\"available\":false") != std::string::npos);

    if (info.find ("\"open\":true") == std::string::npos)
    {
        std::printf ("no audio output on this machine: skipping the real-device checks\n");
        return;
    }

    // The real default device: describe it and choose it explicitly.
    const auto type = jsonString (info, "typeName"), name = jsonString (info, "deviceName");
    const std::string req = "{\"typeName\":\"" + type + "\",\"deviceName\":\"" + name + "\"}";
    CHECK (lp_engine_describe_device (e, req.c_str(), buf.data(), buf.size(), &required) == LP_OK);
    const std::string caps (buf.data());
    std::printf ("device caps: %s\n", caps.c_str());
    CHECK (caps.find ("\"available\":true") != std::string::npos && caps.find ("\"sampleRates\":[") != std::string::npos);
    CHECK (lp_engine_set_audio_device (e, req.c_str()) == LP_OK);
    info = outputInfo (e);
    CHECK (info.find ("\"usingPreferred\":true") != std::string::npos);

    // Bus outputs: must exist; split needs two different ones.
    CHECK (lp_engine_set_output_channels (e, 0, 60) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_output_channels (e, -1, 0) == LP_ERR_INVALID_ARGUMENT);
    if (lp_engine_set_output_mode (e, LP_OUTPUT_SPLIT) == LP_OK)
    {
        CHECK (lp_engine_set_output_channels (e, 1, 0) == LP_OK);
        CHECK (outputInfo (e).find ("\"mainChannel\":1,\"monitorChannel\":0") != std::string::npos);
        CHECK (lp_engine_set_output_channels (e, 0, 0) == LP_ERR_INVALID_ARGUMENT);
        CHECK (lp_engine_set_output_mode (e, LP_OUTPUT_STEREO) == LP_OK);
    }

    // Test tone: valid output starts (stopped right away: tests stay silent).
    CHECK (lp_engine_test_tone (e, 99) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_test_tone (e, -2) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_test_tone (e, -1) == LP_OK);
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
    CHECK (lp_engine_set_master_gain (e, 4.5) == LP_ERR_INVALID_ARGUMENT);
    CHECK (lp_engine_set_master_gain (e, 2.512) == LP_OK); // +8 dB
    CHECK (lp_engine_set_master_gain (e, 1.0) == LP_OK);
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
        if (cycle == 2)
            testDeviceSelection (e);
        lp_engine_destroy (e);
    }
    lp_engine_destroy (nullptr); // must be a no-op

    if (failures == 0)
        std::printf ("engine_c_api: all checks passed\n");
    return failures == 0 ? 0 : 1;
}
