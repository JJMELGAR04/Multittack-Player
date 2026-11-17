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

#define LP_ENGINE_ABI_VERSION 2u

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
 *   {"deviceTypes":[{"name":"Windows Audio","outputDevices":["Speakers (...)"]}]}
 */
lp_result lp_engine_describe_audio_devices(lp_engine* engine, char* buffer, size_t capacity, size_t* out_required);

/* ---- Audio output device (phase 2: system default output) ---- */

/**
 * Opens the system's default output device if it is not open yet.
 * Idempotent. On failure returns LP_ERR_INTERNAL and sets the last error.
 */
lp_result lp_engine_open_default_output(lp_engine* engine);

/**
 * JSON describing the open output device:
 *   {"open":true,"typeName":"Windows Audio","deviceName":"...",
 *    "sampleRate":48000,"bufferSize":480,"outputLatencyMs":20.0}
 * ("open":false and no other fields when no device is open.)
 */
lp_result lp_engine_get_output_info(lp_engine* engine, char* buffer, size_t capacity, size_t* out_required);

/* ---- Songs ---- */

/**
 * Starts loading a multitrack song in the background. `request_json` is
 *   {"tracks":[{"path":"C:\\...\\Drums.wav","name":"Drums"}, ...]}
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
 *            "tracks":[{"name":"Drums","path":"...","format":"WAV",
 *                       "sourceSampleRate":44100,"channels":2,
 *                       "durationSec":215.3,"resampled":true}]},
 *    "analysis":{"state":"pending|running|done|error","revision":1,
 *                "tempo":{"bpm":72.0,"confidence":0.9,"beatOffsetSec":0.41,
 *                         "downbeatOffsetSec":0.41,"source":"click|mix"},
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
 * Re-runs section detection in the background using a user-confirmed tempo
 * (bpm > 0) and bar grid start (downbeat_offset_sec >= 0). Pass bpm <= 0 to
 * use the detected tempo. The analysis "revision" increases when done.
 */
lp_result lp_engine_detect_sections(lp_engine* engine, double bpm, double downbeat_offset_sec);

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
} lp_transport_state;

/** Starts or resumes playback (from 0 if the song had ended). Click-free fade in. */
lp_result lp_engine_play(lp_engine* engine);
/** Pauses with a short fade out; position is kept. */
lp_result lp_engine_pause(lp_engine* engine);
/** Stops with a short fade out and returns to the start. */
lp_result lp_engine_stop(lp_engine* engine);
/** Moves to `position_sec` (song time). While playing: fade out, jump, fade in. */
lp_result lp_engine_seek(lp_engine* engine, double position_sec);
/** Master volume, linear 0..2 (1 = unity). Smoothed, never steps. */
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
