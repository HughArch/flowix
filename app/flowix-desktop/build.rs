use std::fs;
use std::path::{Path, PathBuf};

fn collect_template_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    let entries = fs::read_dir(directory).unwrap_or_else(|error| {
        panic!(
            "failed to read template directory {}: {error}",
            directory.display()
        )
    });

    for entry in entries {
        let entry = entry.expect("failed to read template directory entry");
        let path = entry.path();
        let file_type = entry
            .file_type()
            .unwrap_or_else(|error| panic!("failed to inspect {}: {error}", path.display()));
        if file_type.is_dir() {
            collect_template_files(root, &path, files);
        } else if file_type.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push(path.strip_prefix(root).unwrap().to_path_buf());
        }
    }
}

fn generate_notebook_template_assets() {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let template_root = manifest_dir.join("../../.flowix/templates/notebook-templates");
    let template_root = template_root
        .canonicalize()
        .unwrap_or_else(|error| panic!("notebook template source is unavailable: {error}"));
    println!("cargo:rerun-if-changed={}", template_root.display());

    let mut files = Vec::new();
    collect_template_files(&template_root, &template_root, &mut files);
    files.sort();

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let generated_file = out_dir.join("notebook_template_assets.rs");
    let mut generated = String::from("pub const NOTEBOOK_TEMPLATE_ASSETS: &[(&str, &[u8])] = &[\n");
    for relative in files {
        let absolute = template_root.join(&relative);
        generated.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            relative.to_string_lossy().replace('\\', "/"),
            absolute.to_string_lossy(),
        ));
    }
    generated.push_str("];\n");
    fs::write(generated_file, generated).expect("failed to write generated template asset list");
}

// tauri-build compiles `icons/icon.ico` into the Windows resource and embeds
// the default window icon through `generate_context!`, but it only declares
// the Tauri config as a build input. Declaring the icon files here keeps the
// embedded icon in sync: otherwise a rebuilt icon set is silently ignored and
// `tauri dev` keeps launching a binary that still carries the old artwork.
fn rerun_on_icon_change() {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    for icon in [
        "icons/icon.ico",
        "icons/icon.icns",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={}", manifest_dir.join(icon).display());
    }
}

fn main() {
    generate_notebook_template_assets();
    embed_windows_manifest();
    rerun_on_icon_change();
    let dev_mode = std::env::var_os("FLOWIX_DEV_MODE").is_some();
    println!("cargo:rerun-if-env-changed=FLOWIX_DEV_MODE");
    println!("cargo:rustc-env=FLOWIX_DEV_MODE={}", if dev_mode { "1" } else { "0" });

    // `tauri dev` launches the macOS executable directly instead of an
    // `.app` bundle, so the bundle plist configured in tauri.conf.json is
    // unavailable to AppKit/WebKit while developing. Embed the localization
    // metadata in the executable as well; this is also harmless for release
    // builds, whose packaged bundle has its own generated Info.plist.
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"),
        );
        let info_plist = if dev_mode {
            let source = std::fs::read_to_string(manifest_dir.join("Info.plist"))
                .expect("failed to read Info.plist");
            println!("cargo:rerun-if-changed={}", manifest_dir.join("Info.plist").display());
            let dev = source.replace("<string>flowix</string>", "<string>flowix-dev</string>")
                .replace("<string>Flowix</string>", "<string>Flowix Dev</string>")
                .replace("com.flowix.app.deeplink", "com.flowix-dev.app.deeplink");
            let generated = std::path::PathBuf::from(
                std::env::var_os("OUT_DIR").expect("OUT_DIR is set"),
            ).join("Flowix-Dev-Info.plist");
            std::fs::write(&generated, dev).expect("failed to write dev Info.plist");
            generated
        } else {
            manifest_dir.join("Info.plist")
        };
        println!("cargo:rerun-if-changed={}", info_plist.display());
        println!("cargo:rustc-link-arg-bin=flowix-desktop=-sectcreate");
        println!("cargo:rustc-link-arg-bin=flowix-desktop=__TEXT");
        println!("cargo:rustc-link-arg-bin=flowix-desktop=__info_plist");
        println!(
            "cargo:rustc-link-arg-bin=flowix-desktop={}",
            info_plist.display()
        );
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");
}

// `TaskDialogIndirect` is a comctl32 v6-only export imported statically by
// rfd (via the `common-controls-v6` feature). tauri-build embeds the app
// manifest through a .res attached with bin-scoped link args, so `cargo test`
// executables carry no RT_MANIFEST resource: Windows then binds comctl32 v5
// and the test binary dies at load with STATUS_ENTRYPOINT_NOT_FOUND
// (0xc0000139). Cargo has no test-scoped link-arg instruction (verified on
// 1.95; `rustc-link-arg-test(s)` is rejected, and link args never propagate
// across packages), so the manifest moves here: tauri-build runs with
// `new_without_app_manifest()` and this linker flag re-adds the identical
// Common-Controls 6.0 manifest for every link target, tests included. The
// .res keeps icon and version info; only the manifest source changes.
const WINDOWS_APP_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn embed_windows_manifest() {
    if std::env::var_os("CARGO_CFG_TARGET_OS").as_deref() != Some(std::ffi::OsStr::new("windows"))
        || std::env::var_os("CARGO_CFG_TARGET_ENV").as_deref() != Some(std::ffi::OsStr::new("msvc"))
    {
        return;
    }
    let path = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set"))
        .join("windows-app.manifest");
    fs::write(&path, WINDOWS_APP_MANIFEST).expect("failed to write Windows app manifest");
    println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
    // Matches tauri's .res manifest, which carries no UAC fragment.
    println!("cargo::rustc-link-arg=/MANIFESTUAC:NO");
    println!("cargo::rustc-link-arg=/MANIFESTINPUT:{}", path.display());
}
