// Per-architecture package names.
//
// The Rust architecture name (`std::env::consts::ARCH`) is not the name that
// appears in a distribution's package metadata. Kept separate from the
// launcher's Rust-side table in `packages/app-lib/src/util/arch.rs`, because
// this file is only reachable from packaging scripts and must not pull the
// Rust crate in.

/**
 * Package names for one architecture.
 *
 * @typedef {{deb: string, rpm: string | null, appImage: string | null}} ArchPackageNames
 */

/** @type {Record<string, ArchPackageNames>} */
const PACKAGE_NAMES = {
	x86_64: { deb: 'amd64', rpm: 'x86_64', appImage: 'amd64' },
	aarch64: { deb: 'arm64', rpm: 'aarch64', appImage: 'aarch64' },
	// No RPM target is defined for 32-bit x86 in this build.
	x86: { deb: 'i386', rpm: null, appImage: 'i386' },
	riscv64: { deb: 'riscv64', rpm: 'riscv64', appImage: null },
	loongarch64: { deb: 'loong64', rpm: 'loong64', appImage: null },
}

/**
 * The package names for a Rust architecture.
 *
 * @param {string} rustArch
 * @returns {ArchPackageNames | null} `null` for an architecture with no entry
 */
export function archPackageNames(rustArch) {
	return PACKAGE_NAMES[rustArch] ?? null
}

/**
 * Architectures that can be packaged as a .deb.
 *
 * @returns {string[]}
 */
export function debPackagedArches() {
	return Object.entries(PACKAGE_NAMES)
		.filter(([, names]) => names.deb !== null)
		.map(([arch]) => arch)
		.sort()
}

/**
 * Whether an architecture has a prebuilt AppImage runtime available.
 *
 * AppImage embeds a prebuilt runtime interpreter. linuxdeploy publishes one
 * only for these four architectures, so no riscv64 or loongarch64 AppImage can
 * be built: there is no runtime to embed.
 *
 * @param {string} rustArch
 * @returns {boolean}
 */
export function hasAppImageRuntime(rustArch) {
	// An unknown architecture has no entry, and `undefined !== null` would
	// wrongly report that a runtime exists for it.
	return PACKAGE_NAMES[rustArch]?.appImage != null
}