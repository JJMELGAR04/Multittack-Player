//! Builds the C++/JUCE engine with CMake and links it statically.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // Note: no `canonicalize()` - on Windows it yields `\\?\C:\...` verbatim
    // paths that MSVC/MSBuild cannot open.
    let repo_root = manifest.parent().and_then(|p| p.parent()).expect("repo root");
    let engine_dir = repo_root.join("engine");
    assert!(engine_dir.join("CMakeLists.txt").exists(), "engine/ directory not found");

    for sub in ["CMakeLists.txt", "include", "src"] {
        println!("cargo:rerun-if-changed={}", engine_dir.join(sub).display());
    }
    println!("cargo:rerun-if-env-changed=LIVEPLAYER_JUCE_DIR");
    println!("cargo:rerun-if-env-changed=LIVEPLAYER_ASIO_SDK_DIR");
    // ASIO is compiled in when the SDK is present (tools/fetch-asio-sdk.mjs).
    println!("cargo:rerun-if-changed={}", repo_root.join("third_party/asio").display());

    let mut cfg = cmake::Config::new(&engine_dir);
    // Always optimised: real-time audio code must not run unoptimised, and the
    // Rust binary links the release CRT (/MD) on MSVC.
    cfg.profile("RelWithDebInfo")
        .define("LIVEPLAYER_ENGINE_BUILD_TESTS", "OFF");
    if let Ok(juce) = std::env::var("LIVEPLAYER_JUCE_DIR") {
        cfg.define("LIVEPLAYER_JUCE_DIR", juce);
    }
    if let Ok(asio) = std::env::var("LIVEPLAYER_ASIO_SDK_DIR") {
        cfg.define("LIVEPLAYER_ASIO_SDK_DIR", asio);
    }
    let dst = cfg.build();

    println!("cargo:rustc-link-search=native={}", dst.join("lib").display());
    println!("cargo:rustc-link-lib=static=liveplayer_engine");

    // System libraries required by JUCE's audio/device modules.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    match target_os.as_str() {
        // Win32 libraries used by juce_core/events/audio_devices. (JUCE embeds
        // some via #pragma comment, but not all of them.)
        "windows" => {
            for lib in [
                "kernel32", "user32", "shell32", "ole32", "oleaut32", "advapi32", "winmm", "version",
                "ws2_32", "wininet", "shlwapi", "rpcrt4", "uuid", "imm32", "comdlg32", "dsound",
            ] {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        "macos" => {
            for fw in ["CoreAudio", "CoreMIDI", "AudioToolbox", "Accelerate", "Foundation", "AppKit", "IOKit"] {
                println!("cargo:rustc-link-lib=framework={fw}");
            }
            println!("cargo:rustc-link-lib=c++");
        }
        "linux" => {
            for lib in ["stdc++", "asound", "pthread", "dl"] {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        other => println!("cargo:warning=liveplayer-engine: target '{other}' is not supported yet"),
    }
}
