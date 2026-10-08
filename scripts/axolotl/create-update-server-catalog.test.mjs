import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axolotl-update-catalog-'))
const releasePath = path.join(directory, 'release.json')
const output = path.join(directory, 'catalog.json')
const files = [
	'Axolotl.Launcher-1.9.5-beta.1-1.aarch64.rpm',
	'Axolotl.Launcher-1.9.5-beta.1-1.aarch64.rpm.sig',
	'Axolotl.Launcher-1.9.5-beta.1-1.riscv64.rpm',
	'Axolotl.Launcher-1.9.5-beta.1-1.riscv64.rpm.sig',
	'Axolotl.Launcher-1.9.5-beta.1-1.x86_64.rpm',
	'Axolotl.Launcher-1.9.5-beta.1-1.x86_64.rpm.sig',
	'Axolotl.Launcher_1.9.5-beta.1_aarch64.AppImage',
	'Axolotl.Launcher_1.9.5-beta.1_aarch64.AppImage.sig',
	'Axolotl.Launcher_1.9.5-beta.1_aarch64.AppImage.tar.gz',
	'Axolotl.Launcher_1.9.5-beta.1_aarch64.AppImage.tar.gz.sig',
	'Axolotl.Launcher_1.9.5-beta.1_amd64.AppImage',
	'Axolotl.Launcher_1.9.5-beta.1_amd64.AppImage.sig',
	'Axolotl.Launcher_1.9.5-beta.1_amd64.AppImage.tar.gz',
	'Axolotl.Launcher_1.9.5-beta.1_amd64.AppImage.tar.gz.sig',
	'Axolotl.Launcher_1.9.5-beta.1_amd64.deb',
	'Axolotl.Launcher_1.9.5-beta.1_amd64.deb.sig',
	'Axolotl.Launcher_1.9.5-beta.1_arm64.deb',
	'Axolotl.Launcher_1.9.5-beta.1_arm64.deb.sig',
	'Axolotl.Launcher_1.9.5-beta.1_riscv64.deb',
	'Axolotl.Launcher_1.9.5-beta.1_riscv64.deb.sig',
	'Axolotl.Launcher_1.9.5-beta.1_loong64.deb',
	'Axolotl.Launcher_1.9.5-beta.1_loong64.deb.sig',
	'Axolotl.Launcher_1.9.5-beta.1_universal.dmg',
	'Axolotl.Launcher_1.9.5-beta.1_x64-setup.exe',
	'Axolotl.Launcher_1.9.5-beta.1_x64-setup.exe.sig',
	'Axolotl.Launcher_1.9.5-beta.1_x64-setup.nsis.zip',
	'Axolotl.Launcher_1.9.5-beta.1_x64-setup.nsis.zip.sig',
	'Axolotl.Launcher_universal.app.tar.gz',
	'Axolotl.Launcher_universal.app.tar.gz.sig',
	'Axolotl_Launcher_1.9.5-beta.1_x64_modern-setup.exe',
	'Axolotl_Launcher_1.9.5-beta.1_x64_modern-setup.exe.sig',
	'Axolotl_Launcher_1.9.5-beta.1_x64_nsis-setup.exe',
	'Axolotl_Launcher_1.9.5-beta.1_x64_nsis-setup.exe.sig',
	'Axolotl_Launcher_1.9.5-beta.1_x64_portable.zip',
]

try {
	fs.writeFileSync(
		releasePath,
		JSON.stringify({
			assets: files.map((name, index) => ({
				name,
				size: index + 1,
				digest: `sha256:${crypto.createHash('sha256').update(name).digest('hex')}`,
				browser_download_url: `https://github.com/Mystic-Stars/Axolotl/releases/download/v1.9.5-beta.1/${name}`,
			})),
		}),
	)
	const result = spawnSync(
		process.execPath,
		['scripts/axolotl/create-update-server-catalog.mjs', releasePath, 'v1.9.5-beta.1', output],
		{ cwd: path.resolve(import.meta.dirname, '..', '..'), encoding: 'utf8' },
	)
	assert.equal(result.status, 0, result.stderr)
	const catalog = JSON.parse(fs.readFileSync(output, 'utf8'))
	assert.equal(catalog.version, '1.9.5-beta.1')
	assert.equal(catalog.files.length, files.length)
	assert.deepEqual(
		catalog.artifacts.find((artifact) => artifact.filename.endsWith('_amd64.AppImage.tar.gz'))
			.targetPlatforms,
		['linux-x86_64'],
	)
	assert.equal(
		catalog.artifacts.find((artifact) => artifact.filename.endsWith('modern-setup.exe')).variant,
		'modern',
	)
	assert.equal(
		catalog.artifacts.find((artifact) => artifact.filename.endsWith('portable.zip')).kind,
		'portable',
	)
	assert.deepEqual(
		catalog.artifacts.find((artifact) => artifact.filename.endsWith('_universal.app.tar.gz'))
			.targetPlatforms,
		['darwin-aarch64', 'darwin-x86_64'],
	)

	// The riscv64 and loongarch64 debs are the updater artifacts for those
	// architectures, so they must be classified as updaters rather than
	// falling through to the "unrecognized release artifact" error.
	for (const [suffix, platform] of [
		['_riscv64.deb', 'linux-riscv64'],
		['_loong64.deb', 'linux-loongarch64'],
	]) {
		const artifact = catalog.artifacts.find((candidate) =>
			candidate.filename.endsWith(suffix),
		)
		assert.deepEqual(artifact.targetPlatforms, [platform])
		assert.equal(artifact.kind, 'updater')
	}

	assert.equal(
		catalog.artifacts.find((artifact) => artifact.filename.endsWith('_loong64.deb'))
			.architecture,
		'loongarch64',
	)
	assert.equal(
		catalog.artifacts.find((artifact) => artifact.filename.endsWith('1.riscv64.rpm'))
			.architecture,
		'riscv64',
	)
} finally {
	fs.rmSync(directory, { recursive: true, force: true })
}
