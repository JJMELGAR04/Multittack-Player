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
 *  - Any breaking change to this header bumps LP_ENGINE_ABI_VERSION.
 */
#ifndef LIVEPLAYER_ENGINE_H
#define LIVEPLAYER_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LP_ENGINE_ABI_VERSION 1u

typedef struct lp_engine lp_engine;

typedef enum lp_result {
    LP_OK = 0,
    LP_ERR_INVALID_ARGUMENT = 1,
    LP_ERR_BUFFER_TOO_SMALL = 2,
    LP_ERR_INTERNAL = 3
} lp_result;

/* ---- Static information (thread-safe, no engine instance required) ---- */

/** ABI version this library was compiled with (compare to LP_ENGINE_ABI_VERSION). */
uint32_t lp_engine_abi_version(void);

/** Engine semantic version, e.g. "0.1.0". */
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

/**
 * Round-trip check for host <-> engine communication.
 * Writes `value + 1` into *out_value.
 */
lp_result lp_engine_ping(lp_engine* engine, int64_t value, int64_t* out_value);

/**
 * Writes a JSON document describing the audio back-ends available on this
 * system and their output devices (read-only scan, no device is opened):
 *
 *   {"deviceTypes":[{"name":"Windows Audio","outputDevices":["Speakers (...)"]}]}
 *
 * Two-call pattern: pass buffer=NULL/capacity=0 to obtain the required size
 * (including the terminating NUL) in *out_required, then call again.
 * Returns LP_ERR_BUFFER_TOO_SMALL if `capacity` is insufficient.
 */
lp_result lp_engine_describe_audio_devices(lp_engine* engine,
                                           char* buffer,
                                           size_t capacity,
                                           size_t* out_required);

#ifdef __cplusplus
}
#endif

#endif /* LIVEPLAYER_ENGINE_H */
