use serde::Serialize;

use crate::error::CommandResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    app_name: &'static str,
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
pub fn app_info() -> CommandResult<AppInfo> {
    Ok(AppInfo {
        app_name: "LIVEPLAYER",
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })
}

/// License texts shown in General Settings › Acerca de. They are compiled into
/// the executable, so the installed app always carries them (AGPL/MIT notices).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLicenses {
    license: &'static str,
    third_party: &'static str,
    source_url: &'static str,
}

#[tauri::command]
pub fn app_licenses() -> CommandResult<AppLicenses> {
    Ok(AppLicenses {
        license: include_str!("../../../../../LICENSE"),
        third_party: include_str!("../../../../../THIRD_PARTY_NOTICES.md"),
        source_url: "https://github.com/JJMELGAR04/Multittack-Player",
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn licenses_are_embedded() {
        let l = super::app_licenses().unwrap();
        assert!(l.license.contains("GNU AFFERO GENERAL PUBLIC LICENSE"));
        assert!(l.third_party.contains("JUCE"));
        assert!(l.third_party.contains("Aleksey Vaneev"));
    }
}
