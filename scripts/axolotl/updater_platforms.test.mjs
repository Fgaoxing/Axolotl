import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	architectureForAsset,
	requiredUpdaterPlatforms,
	updaterPlatformsForAsset,
	updaterTargets,
} from './updater_platforms.mjs'

test('every Linux target is served by a distinct asset', () => {
	const linux = updaterTargets().filter((target) =>
		target.platforms.some((platform) => platform.startsWith('linux-')),
	)
	assert.deepEqual(
		linux.map((target) => target.platforms[0]),
		['linux-x86_64', 'linux-aarch64', 'linux-riscv64'],
	)
	// A repeated suffix would make two architectures resolve to the same
	// release asset, so the manifest would point one of them at another
	// architecture's binary.
	assert.equal(new Set(linux.map((target) => target.assetSuffix)).size, linux.length)
})

test('riscv64 is served by its deb because it has no AppImage', () => {
	// tauri-bundler rejects riscv64 in its AppImage backend, so the release
	// build produces only a deb for that architecture. Looking for an AppImage
	// would fail the release on a missing asset.
	const riscv = updaterTargets().find((target) =>
		target.platforms.includes('linux-riscv64'),
	)
	assert.equal(riscv.assetSuffix, '_riscv64.deb')
	assert.deepEqual(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_riscv64.deb'), [
		'linux-riscv64',
	])
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_riscv64.AppImage.tar.gz'), null)
})

test('loongarch64 is not served because tauri-bundler cannot bundle it', () => {
	// The launcher cross-compiles for loongarch64, but tauri-bundler's
	// `binary_arch` panics on the triple, so no release asset exists. Claiming
	// the platform here would make every release fail manifest verification.
	assert.ok(!requiredUpdaterPlatforms().includes('linux-loongarch64'))
})

test('the required platform list matches the target table', () => {
	assert.deepEqual(
		requiredUpdaterPlatforms().slice().sort(),
		updaterTargets()
			.flatMap((target) => target.platforms)
			.sort(),
	)
})

test('mips is not offered by the updater', () => {
	// There is no Rust mips target and no webview for it, so an mips entry
	// would point at a release that can never be produced.
	for (const platform of requiredUpdaterPlatforms()) {
		assert.ok(!platform.includes('mips'), `${platform} should not exist`)
	}
})

test('asset classification finds the platforms each updater asset serves', () => {
	assert.deepEqual(updaterPlatformsForAsset('Axolotl.Launcher_universal.app.tar.gz'), [
		'darwin-aarch64',
		'darwin-x86_64',
	])
	assert.deepEqual(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_amd64.AppImage.tar.gz'), [
		'linux-x86_64',
	])
	// Tauri names the aarch64 AppImage `aarch64`, while its deb and rpm use the
	// Debian spelling `arm64`. Asserting the real spelling here keeps the table
	// from drifting toward the deb name, which would stop the release build
	// from matching its own AppImage.
	assert.deepEqual(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_aarch64.AppImage.tar.gz'), [
		'linux-aarch64',
	])
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_arm64.AppImage.tar.gz'), null)
	assert.deepEqual(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_riscv64.deb'), [
		'linux-riscv64',
	])
	assert.deepEqual(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_x64-setup.nsis.zip'), [
		'windows-x86_64',
	])
})

test('installers and signatures are not updater assets', () => {
	// The x86_64 deb is a plain installer; only riscv64's deb is an updater
	// asset, because that architecture has no AppImage to serve instead.
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_amd64.deb'), null)
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_arm64.deb'), null)
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_amd64.AppImage'), null)
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_universal.dmg'), null)
	assert.equal(updaterPlatformsForAsset('Axolotl.Launcher_1.9.7_riscv64.deb.sig'), null)
})

test('architecture names are read from the filename', () => {
	assert.equal(architectureForAsset('Axolotl.Launcher_universal.dmg'), 'universal')
	assert.equal(architectureForAsset('Axolotl.Launcher_1.9.7_amd64.deb'), 'x86_64')
	assert.equal(architectureForAsset('Axolotl.Launcher_1.9.7_arm64.deb'), 'aarch64')
	assert.equal(architectureForAsset('Axolotl.Launcher_1.9.7_riscv64.deb'), 'riscv64')
	assert.equal(architectureForAsset('Axolotl.Launcher_1.9.7_loong64.deb'), 'loongarch64')
	assert.equal(architectureForAsset('Axolotl.Launcher_1.9.7_x64-setup.exe'), 'x86_64')
	assert.equal(architectureForAsset('latest.json'), null)
})

test('a loong64 filename is not misread as x86_64 or aarch64', () => {
	// Every LoongArch name ends in `64`, so a looser pattern could match it
	// under a different architecture and hand the Update Server a client that
	// would download a binary of the wrong CPU type.
	const name = 'Axolotl.Launcher-1.9.7-1.loongarch64.rpm'
	assert.equal(architectureForAsset(name), 'loongarch64')
})
