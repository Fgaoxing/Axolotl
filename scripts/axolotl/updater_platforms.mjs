// The launcher's updater platform table.
//
// One description of every platform the updater serves, shared by the scripts
// that build the manifest, describe the Update Server catalog, and verify a
// published release. These scripts previously each carried their own copy of
// the list, so adding an architecture meant editing three files that had to
// agree, and a miss in any one of them silently left that architecture without
// updates.
//
// The key format is fixed by the launcher's `X-Axolotl-Platform` header: the
// manifest OS name (`darwin` for macOS) joined to the Rust architecture name.

// Linux entries pair a manifest platform key with the release asset that serves
// it and the architecture name that asset's filename carries.
//
// The asset suffix differs per architecture. x86_64 and aarch64 are served by
// an AppImage, which tauri-bundler names with its own spelling (`aarch64`,
// while the deb for the same build is `arm64`). riscv64 has no AppImage at all:
// tauri-bundler's AppImage backend rejects the architecture, so that build is
// served by its `.deb` instead.
//
// loongarch64 is deliberately absent. The launcher cross-compiles and links for
// it, but tauri-bundler's `binary_arch` panics on the target triple, so no
// bundle can be produced and there is no asset to serve updates from. Add it
// here once tauri-bundler supports the architecture.
const linuxTargets = [
	{ platform: 'linux-x86_64', assetSuffix: '_amd64.AppImage.tar.gz' },
	{ platform: 'linux-aarch64', assetSuffix: '_aarch64.AppImage.tar.gz' },
	{ platform: 'linux-riscv64', assetSuffix: '_riscv64.deb' },
]

/**
 * The manifest target table, as `{ platforms, assetSuffix }` entries.
 *
 * @returns {{platforms: string[], assetSuffix: string}[]}
 */
export function updaterTargets() {
	return [
		{
			platforms: ['darwin-aarch64', 'darwin-x86_64'],
			assetSuffix: '_universal.app.tar.gz',
		},
		...linuxTargets.map(({ platform, assetSuffix }) => ({
			platforms: [platform],
			assetSuffix,
		})),
		{
			platforms: ['windows-x86_64'],
			assetSuffix: '_x64-setup.nsis.zip',
		},
	]
}

/**
 * Every platform key a published manifest must contain.
 *
 * @returns {string[]}
 */
export function requiredUpdaterPlatforms() {
	return updaterTargets().flatMap((target) => target.platforms)
}

/**
 * The platform keys an updater asset serves, or `null` if it serves none.
 *
 * Used when classifying release assets, where an unrecognised name must be
 * distinguishable from one that maps to no platforms.
 *
 * @param {string} filename
 * @returns {string[] | null}
 */
export function updaterPlatformsForAsset(filename) {
	for (const target of updaterTargets()) {
		if (filename.endsWith(target.assetSuffix)) return target.platforms
	}
	return null
}

/**
 * The architecture name an asset filename refers to.
 *
 * @param {string} filename
 * @returns {string | null}
 */
export function architectureForAsset(filename) {
	if (/universal/i.test(filename)) return 'universal'
	// Longest spellings first: `aarch64` and `x86_64` both contain `64`, and an
	// unanchored test would otherwise let a shorter name match inside a longer
	// one.
	const archPatterns = [
		[/aarch64|arm64/i, 'aarch64'],
		[/amd64|x86_64|x64/i, 'x86_64'],
		[/loongarch64|loong64/i, 'loongarch64'],
		[/riscv64/i, 'riscv64'],
	]
	for (const [pattern, arch] of archPatterns) {
		if (pattern.test(filename)) return arch
	}
	return null
}
