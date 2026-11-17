/*
 * LIVEPLAYER native engine - public C ABI.
 *
 * This header is the ONLY contract between the engine (C++/JUCE) and its
 * hosts. A plain C ABI is used on purpose so the same engine can be linked
 * from Rust (Tauri desktop), Kotlin/JNI (Android) or Swift (iPadOS) without
 * exposing C++ types or JUCE across the boundary.
 *
 * Rules:
 *  - No C++ exception ever crosses this boundary.
 *  - Strings returned as `const char*` are UTF-8, NUL-terminated and owned by
 *    the engine. Static strings live forever; per-engine strings stay valid
 *    until the next call on the same engine or until it is destroyed.
 *  - Unless stated otherwise, functions taking an `lp_engine*` must be called
 *    from the host's control thread (never from the audio thread).
 *  - Functions returning JSON use the two-call pattern: pass buffer=NULL and
 *    capacity=0 to get the required size (including the NUL) in
 *    *out_required, then call again with a large enough buffer.
 *    LP_ERR_BUFFER_TOO_SMALL is returned if `capacity` is insufficient.
 *  - Any breaking change to this header bumps LP_ENGINE_ABI_VERSION.
 */
#ifndef LIVEPLAYER_ENGINE_H
#define LIVEPLAYER_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LP_ENGINE_ABI_VERSION 5u

typedef struct lp_engine lp_engine;

typedef enum lp_result {
    LP_OK = 0,
    LP_ERR_INVALID_ARGUMENT = 1,
    LP_ERR_BUFFER_TOO_SMALL = 2,
    LP_ERR_INTERNAL = 3,
    /** The operation needs an open audio device or a loaded song. */
    LP_ERR_INVALID_STATE = 4
} lp_result;

/* ---- Static information (thread-safe, no engine instance required) ---- */

/** ABI version this library was compiled with (compare to LP_ENGINE_ABI_VERSION). */
uint32_t lp_engine_abi_version(void);

/** Engine semantic version, e.g. "0.2.0". */
const char* lp_engine_version(void);

/** JUCE version the engine was built against, e.g. "9.0.5". */
const char* lp_engine_juce_version(void);

/** "Debug" or "Release". */
const char* lp_engine_build_type(void);

/* ---- Lifecycle ---- */

/**
 * Creates an engine instance. Must be called on the thread that will act as
 * the engine's control/message thread (the application's main thread).
 * Returns NULL on failure.
 */
lp_engine* lp_engine_create(void);

/** Destroys an engine instance. Passing NULL is a no-op. */
void lp_engine_destroy(lp_engine* engine);

/** Message describing the last error on this engine, or "" if none. */
const char* lp_engine_last_error(const lp_engine* engine);

/* ---- Diagnostics ---- */

/** Round-trip check for host <-> engine communication: *out_value = value + 1. */
lp_result lp_engine_ping(lp_engine* engine, int64_t value, int64_t* out_value);

/**
 * JSON description of the audio back-ends available on this system and their
 * output devices (read-only scan):
 *   {"deviceTypes":[{"name":"Windows Audio","outputDevices":["Speakers (...)"]}],
 *    "asioSupported":true}
 * Driver types on Windows: "Windows Audio" (shared), "Windows Audio (Exclusive
 * Mode)", "Windows Audio (Low Latency Mode)" and "ASIO" (when built with the SDK).
 */
lp_result lp_engine_describe_audio_devices(lp_engine* engine, char* buffer, size_t capacity, size_t* out_required);

/**
 * Capabilities of one device. `request_json` = {"typeName":"...","deviceName":"..."}.
 * Result: {"available":true,"sampleRates":[44100,48000],"bufferSizes":[64,128],
 *          "defaultBufferSize":480,"outputChannelNames":["Out 1","Out 2"],
 *          "hasControlPanel":false}   ("available":false if not connected.)
 */
lp_result lp_engine_describe_device(lp_engine* engine, const char* request_json, char* buffer, size_t capacity, size_t* out_required);

/**
 * Opens and remembers an output device:
 *   {"typeName":"ASIO","deviceName":"Focusrite USB ASIO","sampleRate":48000,"bufferSize":128}
 * (sampleRate/bufferSize 0 or absent = device default). Every output channel
 * of the device is opened. If the device is not connected the default output
 * is used and the choice is reopened automatically when it appears
 * (lp_engine_get_output_info reports "usingPreferred":false). A loaded song
 * is re-decoded for a new sample rate, keeping position, tempo and mix.
 * On failure the previous device stays open and LP_ERR_INTERNAL is returned.
 */
lp_result lp_engine_set_audio_device(lp_engine* engine, const char* request_json);

/**
 * First device output (0-based) used by each bus. Split mode: one output per
 * bus (must differ). Stereo modes: that output and the next one.
 */
lp_result lp_engine_set_output_channels(lp_engine* engine, int32_t main_first, int32_t monitor_first);

/** Line-check tone (1 kHz, -18 dBFS, 2 s) on one device output (0-based); -1 stops it. */
lp_result lp_engine_test_tone(lp_engine* engine, int32_t channel);

/** Opens the driver's own control panel (ASIO). LP_ERR_INVALID_STATE if it has none. */
lp_result lp_engine_show_device_panel(lp_engine* engine);

/* ---- Audio output device (phase 2: system default output) ---- */

/**
 * Opens the system's default output device (up to 4 output channels) if it
 * is not open yet.
 * Idempotent. On failure returns LP_ERR_INTERNAL and sets the last error.
 */
lp_result lp_engine_open_default_output(lp_engine* engine);

/**
 * JSON describing the open output device and its health:
 *   {"open":true,"typeName":"Windows Audio","deviceName":"...",
 *    "sampleRate":48000,"bufferSize":480,"outputChannels":2,"outputLatencyMs":20.0,
 *    "outputChannelNames":[...],"sampleRates":[...],"bufferSizes":[...],
 *    "hasControlPanel":false,"xruns":-1,"cpuLoad":0.03,"underruns":0,
 *    "mainChannel":0,"monitorChannel":1,"outputMode":1,"asioSupported":true,
 *    "reloading":false,"deviceEvents":0,"lastDeviceEvent":"",
 *    "preferred":{...},"usingPreferred":true}
 * Calling it also does the device housekeeping (lost / reconnected device).
 */
lp_result lp_engine_get_output_info(lp_engine* engine, char* buffer, size_t capacity, size_t* out_required);

/* ---- Songs ---- */

/**
 * Starts loading a multitrack song in the background. `request_json` is
 *   {"tracks":[{"path":"C:\\...\\Drums.wav","name":"Drums",
 *               "role":"music|click|guide","bus":"main|monitor"}, ...],
 *    "bpm":72,"beatsPerBar":4}
 * "role"/"bus" are optional (inferred from the name; click/guide -> monitor).
 * "bpm" (optional, > 0) is a tempo known by the user: the analysis then only
 * estimates the bar grid. "beatsPerBar" (default 4) sets the bar length.
 * Supported formats: WAV, MP3, AIFF, FLAC, Ogg Vorbis. Every file is decoded
 * into RAM and converted to the device sample rate with a high-quality
 * resampler, so playback never touches the disk.
 * Opens the default output device if needed. Cancels any load in progress.
 * Poll lp_engine_get_song_status() to follow progress; when it reports
 * "ready" the song replaces the current one (transport stopped at 0).
 */
lp_result lp_engine_load_song(lp_engine* engine, const char* request_json);

/**
 * JSON status of the current/last load and of the loaded song's analysis:
 *   {"state":"idle|loading|ready|error","progress":0.0-1.0,"error":"",
 *    "loadId":3,
 *    "song":{"sampleRate":48000,"durationSec":215.3,"memoryMB":512.0,
 *            "beatsPerBar":4,"mainTrimDb":-7.1,"monitorTrimDb":0.0,
 *            "tracks":[{"name":"Drums","path":"...","format":"WAV",
 *                       "sourceSampleRate":44100,"channels":2,
 *                       "durationSec":215.3,"resampled":true,
 *                       "role":"music","bus":"main"}]},
 *    "analysis":{"state":"pending|running|done|error","revision":1,
 *                "tempo":{"bpm":72.0,"confidence":0.9,"beatOffsetSec":0.41,
 *                         "downbeatOffsetSec":0.41,"source":"click|mix|user"},
 *                "sections":[{"startSec":0,"endSec":12.5,"kind":"intro",
 *                             "label":"Intro","confidence":0.6}]}}
 * Must be polled from the control thread: it also installs a freshly loaded
 * song into the player.
 */
lp_result lp_engine_get_song_status(lp_engine* engine, char* buffer, size_t capacity, size_t* out_required);

/**
 * Waveform overview of the loaded song. `track` = track index, or -1 for the
 * mix of the musical tracks (click/guide tracks excluded when possible).
 * Each byte is the peak absolute amplitude (0-255, linear) of one bucket of
 * LP_PEAKS_PER_SECOND buckets per second of audio. Two-call pattern.
 */
#define LP_PEAKS_PER_SECOND 100
lp_result lp_engine_get_peaks(lp_engine* engine, int32_t track, uint8_t* buffer, size_t capacity, size_t* out_required);

/**
 * Re-runs section detection in the background.
 *  - bpm > 0 and downbeat_offset_sec >= 0: fully user-confirmed grid;
 *  - bpm > 0 and downbeat_offset_sec < 0: known tempo, the bar grid is estimated;
 *  - bpm <= 0: detected tempo.
 * beats_per_bar (1..16) sets the bar length. The analysis "revision"
 * increases when done.
 */
lp_result lp_engine_detect_sections(lp_engine* engine, double bpm, double downbeat_offset_sec, int32_t beats_per_bar);

/* ---- Tracks and output routing ---- */

typedef enum lp_bus {
    LP_BUS_MAIN = 0,    /* instruments: front-of-house / main outputs */
    LP_BUS_MONITOR = 1  /* click and cues: band in-ear monitors only */
} lp_bus;

typedef enum lp_track_role {
    LP_ROLE_MUSIC = 0,
    LP_ROLE_CLICK = 1,
    LP_ROLE_GUIDE = 2  /* spoken cues / guide */
} lp_track_role;

typedef enum lp_output_mode {
    LP_OUTPUT_STEREO = 0, /* everything on outputs 1/2 (rehearsal, headphones) */
    LP_OUTPUT_SPLIT = 1,  /* instruments mono on output 1, click + cues mono on output 2 */
    LP_OUTPUT_QUAD = 2    /* instruments on 1/2, click + cues on 3/4 (needs 4 outputs) */
} lp_output_mode;

/** Sets a track's output bus and analysis role (takes effect immediately). */
lp_result lp_engine_set_track_route(lp_engine* engine, int32_t track, int32_t bus, int32_t role);
/** Per-track gain 0..4 (+12 dB), smoothed (~10 ms): track fader, mute, solo. */
lp_result lp_engine_set_track_gain(lp_engine* engine, int32_t track, double gain);
/** LP_ERR_INVALID_STATE if LP_OUTPUT_QUAD is requested on a device with < 4 outputs. */
lp_result lp_engine_set_output_mode(lp_engine* engine, int32_t mode);
/** Volume of the monitor bus (click + cues), linear 0..4. Smoothed. */
lp_result lp_engine_set_monitor_gain(lp_engine* engine, double gain);

/**
 * Level meters: peak level (linear) with a ~300 ms release. Reading does not
 * reset them (several readers are fine).
 * Layout: one value per track (after its gain), then main L, main R,
 * monitor L, monitor R (after the safety limiters). *out_count receives the
 * number of values (tracks + 4). Two-call pattern on the float count.
 */
lp_result lp_engine_get_meters(lp_engine* engine, float* values, size_t capacity, size_t* out_count);

/* ---- Transport ---- */

typedef enum lp_play_state {
    LP_STOPPED = 0,
    LP_PLAYING = 1,
    LP_PAUSED = 2
} lp_play_state;

typedef struct lp_transport_state {
    int32_t play_state;      /* lp_play_state */
    int32_t ended;           /* 1 when playback stopped by reaching the end */
    int32_t stretching;      /* 1 while time-stretching is active (tempo != 1) */
    int32_t device_xruns;    /* driver-reported glitches since the device opened (-1 = unknown) */
    double position_sec;     /* song position (original tempo time base) */
    double duration_sec;     /* song length (original tempo time base) */
    double tempo_ratio;      /* effective playback speed (1.0 = original) */
    double master_gain;      /* linear */
    double audio_load;       /* 0..1, audio callback CPU usage */
    double render_load;      /* 0..1 of one core, background render thread */
    uint64_t underruns;      /* times the render thread could not keep up (must stay 0) */
    int32_t output_mode;     /* lp_output_mode */
    int32_t output_channels; /* active output channels of the device */
    double monitor_gain;     /* linear */
    double main_limiter_gain;    /* safety limiter gain on the instruments bus (1 = idle) */
    double monitor_limiter_gain; /* same for the click / cues bus */
} lp_transport_state;

/** Starts or resumes playback (from 0 if the song had ended). Click-free fade in. */
lp_result lp_engine_play(lp_engine* engine);
/** Pauses with a short fade out; position is kept. */
lp_result lp_engine_pause(lp_engine* engine);
/** Stops with a short fade out and returns to the start. */
lp_result lp_engine_stop(lp_engine* engine);
/** Moves to `position_sec` (song time). While playing: fade out, jump, fade in. */
lp_result lp_engine_seek(lp_engine* engine, double position_sec);
/** Master volume, linear 0..4 (1 = unity, 4 = +12 dB). Smoothed, never steps. */
lp_result lp_engine_set_master_gain(lp_engine* engine, double gain);
/**
 * Playback speed relative to the original tempo, 0.5..2.0. Pitch is kept.
 * Exactly 1.0 plays the untouched original audio (no processing).
 * Changes glide smoothly instead of jumping.
 */
lp_result lp_engine_set_tempo_ratio(lp_engine* engine, double ratio);
/** Snapshot of the transport. */
lp_result lp_engine_get_transport(lp_engine* engine, lp_transport_state* out_state);

#ifdef __cplusplus
}
#endif

#endif /* LIVEPLAYER_ENGINE_H */
