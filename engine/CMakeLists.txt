cmake_minimum_required(VERSION 3.22)

project(liveplayer_engine
    VERSION 0.1.0
    DESCRIPTION "LIVEPLAYER native real-time audio engine"
    LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# The engine is linked into the Rust/Tauri executable, which always uses the
# release dynamic CRT (/MD) on MSVC. Force the same CRT for every configuration
# to avoid LNK2038 runtime mismatches.
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
    add_compile_options(/utf-8 /MP)
endif()

option(LIVEPLAYER_ENGINE_BUILD_TESTS "Build native engine tests" ON)

# ---------------------------------------------------------------------------
# JUCE (fetched at configure time, pinned to an exact release).
# Licence: AGPLv3 or JUCE EULA - see docs/LICENSING.md.
# ---------------------------------------------------------------------------
include(FetchContent)
set(LIVEPLAYER_JUCE_VERSION "9.0.5" CACHE STRING "JUCE release tag")
# Allow an already-downloaded JUCE checkout (offline builds / CI cache).
set(LIVEPLAYER_JUCE_DIR "" CACHE PATH "Optional local JUCE checkout")
if(NOT LIVEPLAYER_JUCE_DIR AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/JUCE/CMakeLists.txt")
    set(LIVEPLAYER_JUCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/JUCE")
endif()

if(LIVEPLAYER_JUCE_DIR)
    add_subdirectory("${LIVEPLAYER_JUCE_DIR}" "${CMAKE_BINARY_DIR}/juce" EXCLUDE_FROM_ALL)
else()
    FetchContent_Declare(juce
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG        ${LIVEPLAYER_JUCE_VERSION}
        GIT_SHALLOW    TRUE
        GIT_PROGRESS   TRUE)
    FetchContent_MakeAvailable(juce)
endif()

# ---------------------------------------------------------------------------
# Engine static library. Public surface = include/liveplayer_engine.h (C ABI).
# ---------------------------------------------------------------------------
add_library(liveplayer_engine STATIC
    src/engine_c_api.cpp
    src/Engine.cpp
    src/Engine.h)

target_include_directories(liveplayer_engine
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_compile_definitions(liveplayer_engine
    PUBLIC
        LIVEPLAYER_ENGINE_STATIC=1
    PRIVATE
        LIVEPLAYER_ENGINE_VERSION="${PROJECT_VERSION}"
        JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
        JUCE_STANDALONE_APPLICATION=0
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_MODAL_LOOPS_PERMITTED=0
        JUCE_STRICT_REFCOUNTEDPOINTER=1
        # Platform audio back-ends. ASIO is evaluated in phase 4 (needs the
        # Steinberg SDK, which is downloaded separately and never committed).
        JUCE_WASAPI=1
        JUCE_DIRECTSOUND=1
        JUCE_ASIO=0
        JUCE_JACK=0
        JUCE_USE_FLAC=1
        JUCE_USE_OGGVORBIS=1
        JUCE_USE_MP3AUDIOFORMAT=0)

target_link_libraries(liveplayer_engine
    PRIVATE
        juce::juce_core
        juce::juce_events
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

install(TARGETS liveplayer_engine ARCHIVE DESTINATION lib)
install(FILES include/liveplayer_engine.h DESTINATION include)

# ---------------------------------------------------------------------------
# Tests (plain CTest executable, exercising only the public C ABI).
# ---------------------------------------------------------------------------
if(LIVEPLAYER_ENGINE_BUILD_TESTS)
    enable_testing()
    add_executable(liveplayer_engine_tests tests/engine_c_api_tests.cpp)
    target_link_libraries(liveplayer_engine_tests PRIVATE liveplayer_engine)
    add_test(NAME engine_c_api COMMAND liveplayer_engine_tests)
endif()
