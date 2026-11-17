cmake_minimum_required(VERSION 3.24)

project(liveplayer_engine
    VERSION 0.4.0
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
    add_compile_options(/utf-8 /MP /bigobj)
endif()

option(LIVEPLAYER_ENGINE_BUILD_TESTS "Build native engine tests" ON)

include(FetchContent)
set(THIRD_PARTY_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../third_party")

# Uses a local checkout in third_party/<dir> when present (offline builds),
# otherwise downloads the pinned tag.
function(liveplayer_dependency name dir repo tag)
    if(EXISTS "${THIRD_PARTY_DIR}/${dir}")
        set(${name}_SOURCE_DIR "${THIRD_PARTY_DIR}/${dir}" PARENT_SCOPE)
    else()
        FetchContent_Declare(${name} GIT_REPOSITORY ${repo} GIT_TAG ${tag} GIT_SHALLOW TRUE GIT_PROGRESS TRUE)
        FetchContent_MakeAvailable(${name})
        set(${name}_SOURCE_DIR "${${name}_SOURCE_DIR}" PARENT_SCOPE)
    endif()
endfunction()

# ---------------------------------------------------------------------------
# JUCE (AGPLv3, see docs/LICENSING.md)
# ---------------------------------------------------------------------------
set(LIVEPLAYER_JUCE_VERSION "9.0.5" CACHE STRING "JUCE release tag")
set(LIVEPLAYER_JUCE_DIR "" CACHE PATH "Optional local JUCE checkout")
if(NOT LIVEPLAYER_JUCE_DIR AND EXISTS "${THIRD_PARTY_DIR}/JUCE/CMakeLists.txt")
    set(LIVEPLAYER_JUCE_DIR "${THIRD_PARTY_DIR}/JUCE")
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
# Header-only DSP libraries (MIT): time-stretch + high-quality resampling.
# ---------------------------------------------------------------------------
liveplayer_dependency(signalsmith_linear  signalsmith-linear  https://github.com/Signalsmith-Audio/linear.git              0.6.4)
liveplayer_dependency(signalsmith_stretch signalsmith-stretch https://github.com/Signalsmith-Audio/signalsmith-stretch.git 1.4.0)
liveplayer_dependency(r8brain             r8brain             https://github.com/avaneev/r8brain-free-src.git              version-6.5)

# ---------------------------------------------------------------------------
# ASIO (Windows, optional): Steinberg ASIO SDK 2.3.4+, used under its GPLv3
# option (compatible with our AGPLv3). Fetched with tools/fetch-asio-sdk.mjs
# into third_party/asio/ASIOSDK (never committed). Without it, WASAPI only.
# ---------------------------------------------------------------------------
set(LIVEPLAYER_ASIO_SDK_DIR "" CACHE PATH "Steinberg ASIO SDK folder (contains common/iasiodrv.h)")
if(NOT LIVEPLAYER_ASIO_SDK_DIR AND EXISTS "${THIRD_PARTY_DIR}/asio/ASIOSDK/common/iasiodrv.h")
    set(LIVEPLAYER_ASIO_SDK_DIR "${THIRD_PARTY_DIR}/asio/ASIOSDK")
endif()
if(WIN32 AND LIVEPLAYER_ASIO_SDK_DIR AND EXISTS "${LIVEPLAYER_ASIO_SDK_DIR}/common/iasiodrv.h")
    set(LIVEPLAYER_WITH_ASIO 1)
    message(STATUS "LIVEPLAYER: ASIO enabled (${LIVEPLAYER_ASIO_SDK_DIR})")
else()
    set(LIVEPLAYER_WITH_ASIO 0)
    message(STATUS "LIVEPLAYER: ASIO disabled (run: node tools/fetch-asio-sdk.mjs)")
endif()

# ---------------------------------------------------------------------------
# Engine static library. Public surface = include/liveplayer_engine.h (C ABI).
# ---------------------------------------------------------------------------
add_library(liveplayer_engine STATIC
    src/engine_c_api.cpp
    src/Engine.cpp
    src/Engine.h
    src/Player.cpp
    src/Player.h
    src/SongRenderer.cpp
    src/SongRenderer.h
    src/SongLoader.cpp
    src/SongLoader.h
    src/SongData.h
    src/ChunkRing.h
    src/Limiter.h
    src/Analysis.cpp
    src/Analysis.h
    ${r8brain_SOURCE_DIR}/r8bbase.cpp)

target_include_directories(liveplayer_engine
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
# Third-party headers as SYSTEM: their warnings are not ours to fix.
target_include_directories(liveplayer_engine SYSTEM PRIVATE
    ${signalsmith_stretch_SOURCE_DIR}/include
    ${signalsmith_linear_SOURCE_DIR}/include
    ${r8brain_SOURCE_DIR})
if(LIVEPLAYER_WITH_ASIO)
    target_include_directories(liveplayer_engine SYSTEM PRIVATE "${LIVEPLAYER_ASIO_SDK_DIR}/common")
endif()

target_compile_definitions(liveplayer_engine
    PUBLIC
        LIVEPLAYER_ENGINE_STATIC=1
    PRIVATE
        LIVEPLAYER_ENGINE_VERSION="${PROJECT_VERSION}"
        NOMINMAX
        JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
        JUCE_STANDALONE_APPLICATION=0
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_MODAL_LOOPS_PERMITTED=0
        JUCE_STRICT_REFCOUNTEDPOINTER=1
        # Platform audio back-ends (ASIO only when the SDK is present, see above).
        JUCE_WASAPI=1
        JUCE_DIRECTSOUND=0
        JUCE_ASIO=${LIVEPLAYER_WITH_ASIO}
        LIVEPLAYER_WITH_ASIO=${LIVEPLAYER_WITH_ASIO}
        JUCE_JACK=0
        JUCE_USE_FLAC=1
        JUCE_USE_OGGVORBIS=1
        # MP3 decoding (the MP3 patents expired in 2017; JUCE's decoder is free).
        JUCE_USE_MP3AUDIOFORMAT=1
        JUCE_USE_WINDOWS_MEDIA_FORMAT=0
        JUCE_DSP_USE_INTEL_MKL=0
        JUCE_DSP_USE_SHARED_FFTW=0
        JUCE_DSP_USE_STATIC_FFTW=0)

target_link_libraries(liveplayer_engine
    PRIVATE
        juce::juce_core
        juce::juce_events
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

install(TARGETS liveplayer_engine ARCHIVE DESTINATION lib)
install(FILES include/liveplayer_engine.h DESTINATION include)

# ---------------------------------------------------------------------------
# Tests.
#  - engine_c_api: public C ABI only, exactly like any host.
#  - engine_audio: decoding, sync, time-stretch quality/speed and analysis on
#    generated test songs (tools/generate-test-song.mjs, needs Node.js).
# ---------------------------------------------------------------------------
if(LIVEPLAYER_ENGINE_BUILD_TESTS)
    enable_testing()
    add_executable(liveplayer_engine_tests tests/engine_c_api_tests.cpp)
    target_link_libraries(liveplayer_engine_tests PRIVATE liveplayer_engine)
    add_test(NAME engine_c_api COMMAND liveplayer_engine_tests)

    add_executable(liveplayer_engine_audio_tests tests/engine_audio_tests.cpp)
    target_include_directories(liveplayer_engine_audio_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_include_directories(liveplayer_engine_audio_tests SYSTEM PRIVATE
        ${signalsmith_stretch_SOURCE_DIR}/include
        ${signalsmith_linear_SOURCE_DIR}/include
        ${r8brain_SOURCE_DIR})
    target_compile_definitions(liveplayer_engine_audio_tests PRIVATE
        JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 JUCE_STANDALONE_APPLICATION=0 JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0
        JUCE_USE_MP3AUDIOFORMAT=1 JUCE_USE_WINDOWS_MEDIA_FORMAT=0 NOMINMAX)
    # JUCE's module targets would compile the JUCE sources a second time; the
    # test only needs their headers/defines (the code is in liveplayer_engine).
    foreach(module juce_core juce_events juce_audio_basics juce_audio_devices juce_audio_formats juce_dsp)
        target_include_directories(liveplayer_engine_audio_tests SYSTEM PRIVATE $<TARGET_PROPERTY:juce::${module},INTERFACE_INCLUDE_DIRECTORIES>)
        target_compile_definitions(liveplayer_engine_audio_tests PRIVATE $<TARGET_PROPERTY:juce::${module},INTERFACE_COMPILE_DEFINITIONS>)
    endforeach()
    target_link_libraries(liveplayer_engine_audio_tests PRIVATE liveplayer_engine)

    # Developer tool: inspect real songs with the engine (not a test).
    add_executable(liveplayer_inspect tests/inspect_song.cpp)
    target_include_directories(liveplayer_inspect PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
    target_include_directories(liveplayer_inspect SYSTEM PRIVATE ${r8brain_SOURCE_DIR})
    get_target_property(_lp_test_defs liveplayer_engine_audio_tests COMPILE_DEFINITIONS)
    get_target_property(_lp_test_incs liveplayer_engine_audio_tests INCLUDE_DIRECTORIES)
    target_compile_definitions(liveplayer_inspect PRIVATE ${_lp_test_defs})
    target_include_directories(liveplayer_inspect SYSTEM PRIVATE ${_lp_test_incs})
    target_link_libraries(liveplayer_inspect PRIVATE liveplayer_engine)

    set(LIVEPLAYER_TEST_AUDIO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../test-audio")
    find_program(NODE_EXECUTABLE node)
    if(NODE_EXECUTABLE)
        add_test(NAME generate_test_audio
            COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/../tools/generate-test-song.mjs ${LIVEPLAYER_TEST_AUDIO_DIR})
        set_tests_properties(generate_test_audio PROPERTIES FIXTURES_SETUP test_audio)
    endif()
    add_test(NAME engine_audio COMMAND liveplayer_engine_audio_tests ${LIVEPLAYER_TEST_AUDIO_DIR})
    set_tests_properties(engine_audio PROPERTIES FIXTURES_REQUIRED test_audio TIMEOUT 900)
endif()
