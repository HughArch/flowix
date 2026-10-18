import fs from "node:fs";
import path from "node:path";
import { applyTauriSigningKey } from "./resolve-tauri-signing-key.mjs";

applyTauriSigningKey();

const repoRoot = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(repoRoot, "app", "flowix-desktop");
const baseConfigPath = path.join(tauriDir, "tauri.conf.json");
const productionConfigPath = path.join(tauriDir, "tauri.conf.production.json");
const platformArgIndex = process.argv.indexOf("--platform");
const targetPlatform =
  platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : process.platform;
if (!["win32", "darwin", "linux"].includes(targetPlatform)) {
  throw new Error(`Unsupported --platform value: ${targetPlatform ?? "<missing>"}`);
}

const cargoManifest = fs.readFileSync(path.join(repoRoot, "app", "Cargo.toml"), "utf8");
const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoManifest)?.[1];
const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

const allowUnsigned = process.env.FLOWIX_ALLOW_UNSIGNED === "1";
const allowUnsignedWindows =
  allowUnsigned || process.env.FLOWIX_ALLOW_UNSIGNED_WINDOWS === "1";
const hasUpdaterSigningKey = Boolean(
  process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() ||
    process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim(),
);
if (!allowUnsigned && !hasUpdaterSigningKey) {
  throw new Error(
    "TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required for signed Flowix updater artifacts. " +
      "Set FLOWIX_ALLOW_UNSIGNED=1 only for local unsigned packages.",
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stripCommentKeys(value) {
  if (Array.isArray(value)) {
    return value.map(stripCommentKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, child]) => [key, stripCommentKeys(child)]),
    );
  }
  return value;
}

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (!base || typeof base !== "object" || !override || typeof override !== "object") {
    return override === undefined ? base : override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeConfig(base[key], value);
  }
  return merged;
}

function requiredEnv(name, allowMissing = false) {
  const value = process.env[name];
  if (!value && !allowMissing) {
    throw new Error(`${name} is required for a signed production build. Set FLOWIX_ALLOW_UNSIGNED=1 only for local unsigned packages.`);
  }
  return value;
}

const base = stripCommentKeys(readJson(baseConfigPath));
const productionOverride = stripCommentKeys(readJson(productionConfigPath));
const allowUnsignedMac = allowUnsigned;
if (!cargoVersion || cargoVersion !== base.version || cargoVersion !== packageVersion) {
  throw new Error(
    `Flowix version mismatch: Cargo=${cargoVersion ?? "<missing>"}, ` +
    `Tauri=${base.version ?? "<missing>"}, package=${packageVersion ?? "<missing>"}`,
  );
}
let platformOverride = {};
let outputPath;

if (targetPlatform === "win32") {
  platformOverride = stripCommentKeys(readJson(path.join(tauriDir, "tauri.windows.conf.json")));
  outputPath = path.join(tauriDir, "tauri.windows.production.local.json");
} else if (targetPlatform === "darwin") {
  platformOverride = stripCommentKeys(readJson(path.join(tauriDir, "tauri.macos.conf.json")));
  outputPath = path.join(tauriDir, "tauri.macos.production.local.json");
} else {
  outputPath = path.join(tauriDir, "tauri.production.local.json");
}

const production = mergeConfig(mergeConfig(base, platformOverride), productionOverride);
production.bundle ??= {};
production.bundle.resources = {
  ...(production.bundle.resources && !Array.isArray(production.bundle.resources) ? production.bundle.resources : {}),
  [path.join(repoRoot, ".build", "pi-runtime", "provider-catalog.json")]: "pi/provider-catalog.json",
};

// Ship the Flowix-owned DSH profile as an app resource. It is copied into the
// user's selected DSH_HOME only after they explicitly install the App Server
// plugin from Preferences.
const dshProfileStage = path.join(repoRoot, ".build", "dsh-appserver-profile", "flowix");
fs.rmSync(path.dirname(dshProfileStage), { recursive: true, force: true });
fs.mkdirSync(path.join(dshProfileStage, "node_modules"), { recursive: true });
fs.cpSync(path.join(repoRoot, "dsh-appserver"), path.join(dshProfileStage, "node_modules", "dsh-appserver"), {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
});
fs.cpSync(path.join(repoRoot, "dsh-flowix-memory"), path.join(dshProfileStage, "node_modules", "dsh-flowix-memory"), {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
});
fs.copyFileSync(
  path.join(repoRoot, "scripts", "dsh-dev-profile.patch.yml"),
  path.join(dshProfileStage, "cordis.patch.yml"),
);
fs.writeFileSync(path.join(dshProfileStage, "package.json"), `${JSON.stringify({
  name: "dsh-profile-flowix",
  private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-appserver", "dsh-flowix-memory"] } },
}, null, 2)}\n`);
production.bundle.resources[dshProfileStage] = "dsh-profile/flowix";
const piStageRoot = path.join(repoRoot, ".build", "pi-runtime");
const providerCatalog = path.join(piStageRoot, "provider-catalog.json");
if (!fs.existsSync(providerCatalog)) {
  throw new Error("Pi provider catalog is missing. Run scripts/prepare-pi-bundle.mjs before generating the production config.");
}
const piResourcesPath = path.join(piStageRoot, "resources.json");
if (!fs.existsSync(piResourcesPath)) {
  throw new Error("Pi runtime resources are missing. Run scripts/prepare-pi-bundle.mjs before generating the production config.");
}
const piPlatform = { darwin: "darwin", win32: "windows", linux: "linux" }[targetPlatform];
const nativePiPlatform = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform];
const nativePiArch = { arm64: "arm64", x64: "x64" }[process.arch];
const targetArch = process.env.FLOWIX_PI_TARGET_ARCH
  || (nativePiPlatform === piPlatform ? nativePiArch : undefined);
if (!targetArch || !["arm64", "x64"].includes(targetArch)) {
  throw new Error(`Unsupported or missing Pi target architecture: ${targetArch ?? "<missing>"}`);
}
const piTarget = `pi/${piPlatform}-${targetArch}`;
const piResources = JSON.parse(fs.readFileSync(piResourcesPath, "utf8"));
const selectedPiResources = Object.entries(piResources).filter(([, target]) => target === piTarget);
if (selectedPiResources.length !== 1) {
  throw new Error(`Expected exactly one staged Pi runtime for ${piTarget}, found ${selectedPiResources.length}.`);
}
const [piResourceDirectory] = selectedPiResources[0];
const piExecutable = path.join(piResourceDirectory, "dist", targetPlatform === "win32" ? "pi.exe" : "pi");
const piExecutableFallback = path.join(piResourceDirectory, targetPlatform === "win32" ? "pi.exe" : "pi");
const executablePath = [piExecutable, piExecutableFallback].find((candidate) => {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (targetPlatform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
if (!executablePath) {
  throw new Error(`Staged Pi runtime for ${piTarget} is missing or not executable.`);
}
Object.assign(production.bundle.resources, Object.fromEntries(selectedPiResources));
if (allowUnsigned) {
  // Local builds may omit updater artifacts; signed production Flowix builds
  // keep this enabled and require TAURI_SIGNING_PRIVATE_KEY.
  production.bundle.createUpdaterArtifacts = false;
}

if (targetPlatform === "win32") {
  production.bundle.targets = ["nsis"];
  production.bundle.windows ??= {};
  production.bundle.externalBin ??= [];
  if (production.bundle.macOS) {
    delete production.bundle.macOS.signingIdentity;
    delete production.bundle.macOS.providerShortName;
  }
  const thumbprint = requiredEnv("WINDOWS_CERT_THUMBPRINT", allowUnsignedWindows);
  if (thumbprint) {
    production.bundle.windows.certificateThumbprint = thumbprint;
  } else {
    delete production.bundle.windows.certificateThumbprint;
  }
  production.bundle.windows.digestAlgorithm = "sha256";
  production.bundle.windows.timestampUrl = process.env.WINDOWS_TIMESTAMP_URL || "http://timestamp.sectigo.com";
  const mainWindow = production.app?.windows?.[0];
  if (!mainWindow || mainWindow.visible !== false || mainWindow.decorations !== false) {
    throw new Error("Invalid Windows production config: main window must set visible=false and decorations=false.");
  }
} else if (targetPlatform === "darwin") {
  production.bundle.targets = ["app", "dmg"];
  production.bundle.macOS ??= {};
  if (production.bundle.windows) {
    delete production.bundle.windows.certificateThumbprint;
  }
  const signingIdentity = requiredEnv("APPLE_SIGNING_IDENTITY", allowUnsignedMac);
  const teamId = requiredEnv("APPLE_TEAM_ID", allowUnsignedMac);
  if (signingIdentity) {
    production.bundle.macOS.signingIdentity = signingIdentity;
  } else {
    delete production.bundle.macOS.signingIdentity;
  }
  if (teamId) {
    production.bundle.macOS.providerShortName = teamId;
  } else {
    delete production.bundle.macOS.providerShortName;
  }
  production.bundle.macOS.entitlements = "entitlements.plist";
  production.bundle.macOS.hardenedRuntime = true;
  if (signingIdentity) {
    production.build ??= {};
    production.build.beforeBundleCommand = "node scripts/sign-macos-resources.mjs";
  } else {
    delete production.build?.beforeBundleCommand;
  }
} else {
  // The base config targets NSIS for the Windows release. Linux must opt in
  // to AppImage explicitly; otherwise it cannot produce the updater archive
  // consumed by the release collector.
  production.bundle.targets = ["appimage"];
  if (production.bundle.windows) {
    delete production.bundle.windows.certificateThumbprint;
  }
  if (production.bundle.macOS) {
    delete production.bundle.macOS.signingIdentity;
    delete production.bundle.macOS.providerShortName;
  }
}

// The updater manifest is signed per Flowix desktop release. DSH has its own
// runtime manifest and verifies both SHA-256 and the same Tauri/Minisign
// signature; it must not inherit this endpoint configuration.
const updaterEndpointEnv = {
  darwin: "FLOWIX_UPDATER_ENDPOINT_MACOS",
  win32: "FLOWIX_UPDATER_ENDPOINT_WINDOWS",
  linux: "FLOWIX_UPDATER_ENDPOINT_LINUX",
}[targetPlatform];
const updaterEndpointDefault = {
  darwin: "https://download.flowix.cc/updater/macos/latest.json",
  win32: "https://download.flowix.cc/updater/windows/latest.json",
  linux: "https://download.flowix.cc/updater/linux/latest.json",
}[targetPlatform];
const piUpdaterEndpointEnv = {
  darwin: "FLOWIX_UPDATER_ENDPOINT_PI_MACOS",
  win32: "FLOWIX_UPDATER_ENDPOINT_PI_WINDOWS",
  linux: "FLOWIX_UPDATER_ENDPOINT_PI_LINUX",
}[targetPlatform];
const updaterEndpoint = process.env[piUpdaterEndpointEnv]?.trim()
  || process.env[updaterEndpointEnv]?.trim() || updaterEndpointDefault;
// Pi is included in standard production builds; bundling it must not silently
// switch the desktop app to a different updater publication path.
production.plugins ??= {};
production.plugins.updater ??= {};
production.plugins.updater.endpoints = [updaterEndpoint];

fs.writeFileSync(outputPath, `${JSON.stringify(production, null, 2)}\n`);
console.log(path.relative(repoRoot, outputPath));
