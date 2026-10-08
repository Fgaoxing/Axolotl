import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { archPackageNames, debPackagedArches, hasAppImageRuntime } from './arch_package_names.mjs'
import { packageDeb, packageTarball } from './bundle-linux.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const appDir = path.join(repositoryRoot, 'apps/app')

// A payload built for the host architecture keeps these tests independent of
// any cross toolchain. The point under test is the package layout and metadata,
// not the architecture of the bytes inside.
function fakeBinary() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axolotl-fake-'))
	const binary = path.join(dir, 'Axolotl Launcher')
	// An ELF header, so `file` in a test can tell it apart from a script.
	fs.writeFileSync(binary, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]))
	return { dir, binary }
}

function extractMember(debPath, member) {
	return execFileSync('sh', ['-c', `ar p '${debPath}' '${member}' | tar xzOf -`], {
		encoding: 'utf8',
	})
}

test('a built .deb is a well-formed archive with correct metadata', () => {
	const { dir, binary } = fakeBinary()
	const outputDir = path.join(dir, 'out')

	try {
		const debPath = packageDeb({ appDir, binaryPath: binary, rustArch: 'riscv64', outputDir })

		const members = execFileSync('ar', ['t', debPath], { encoding: 'utf8' })
			.split('\n')
			.filter(Boolean)
		// deb-binary(5) fixes the member order and names.
		assert.deepEqual(members, ['debian-binary', 'control.tar.gz', 'data.tar.gz'])

		const control = extractMember(debPath, 'control.tar.gz')
		assert.match(control, /^Package: axolotl-launcher$/m)
		assert.match(control, /^Architecture: riscv64$/m)
		assert.match(control, /^Depends: libwebkit2gtk-4\.1-0, libgtk-3-0/m)
		// dpkg uses Installed-Size for its disk-usage accounting.
		assert.match(control, /^Installed-Size: \d+$/m)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('the package architecture follows the requested target', () => {
	const { dir, binary } = fakeBinary()

	try {
		for (const [rustArch, expected] of [
			['riscv64', 'riscv64'],
			['loongarch64', 'loong64'],
			['x86_64', 'amd64'],
			['aarch64', 'arm64'],
		]) {
			const outputDir = path.join(dir, `out-${rustArch}`)
			const debPath = packageDeb({ appDir, binaryPath: binary, rustArch, outputDir })
			const control = extractMember(debPath, 'control.tar.gz')
			assert.match(
				control,
				new RegExp(`^Architecture: ${expected}$`, 'm'),
				`${rustArch} should package as ${expected}`,
			)
			// The filename must match too: apt users select packages by name.
			assert.ok(debPath.endsWith(`_${expected}.deb`), `${debPath} should name ${expected}`)
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('the payload installs a launchable layout', () => {
	const { dir, binary } = fakeBinary()

	try {
		const debPath = packageDeb({
			appDir,
			binaryPath: binary,
			rustArch: 'riscv64',
			outputDir: path.join(dir, 'out'),
		})

		const extracted = path.join(dir, 'data')
		fs.mkdirSync(extracted)
		execFileSync('sh', ['-c', `ar p '${debPath}' data.tar.gz | tar xzf - -C '${extracted}'`])

		const installed = (relative) => path.join(extracted, relative)
		assert.ok(fs.existsSync(installed('usr/bin/Axolotl Launcher')), 'executable is installed')
		assert.ok(
			fs.existsSync(installed('usr/share/applications/Axolotl Launcher.desktop')),
			'desktop entry is installed',
		)
		// The 128x128@2x icon is a 256px asset and must land in the 256 slot,
		// or the desktop entry resolves to a missing icon.
		assert.ok(
			fs.existsSync(installed('usr/share/icons/hicolor/256x256/apps/Axolotl Launcher.png')),
			'the @2x icon lands in the doubled size directory',
		)
		assert.ok(
			fs.existsSync(installed('usr/share/icons/hicolor/128x128/apps/Axolotl Launcher.png')),
			'the base icon lands in its own size directory',
		)

		// Only configured icons may ship: the icons directory also holds Windows
		// Store logos that have no meaning in a Linux package.
		const iconsDir = installed('usr/share/icons/hicolor')
		const sizes = fs.readdirSync(iconsDir).sort()
		assert.deepEqual(sizes, ['128x128', '256x256'])
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('the declared md5sums match the payload', () => {
	const { dir, binary } = fakeBinary()

	try {
		const debPath = packageDeb({
			appDir,
			binaryPath: binary,
			rustArch: 'riscv64',
			outputDir: path.join(dir, 'out'),
		})

		const declared = extractMember(debPath, 'control.tar.gz')
			.split('\n')
			.filter((line) => line.includes('  '))
		assert.ok(declared.length > 0, 'md5sums is not empty')

		const extracted = path.join(dir, 'data')
		fs.mkdirSync(extracted)
		execFileSync('sh', ['-c', `ar p '${debPath}' data.tar.gz | tar xzf - -C '${extracted}'`])

		for (const line of declared) {
			const [digest, relative] = line.split(/\s{2}/)
			const contents = fs.readFileSync(path.join(extracted, relative))
			const actual = execFileSync('md5sum', ['-'], {
				input: contents,
				encoding: 'utf8',
			}).split(/\s+/)[0]
			assert.equal(actual, digest, `md5 mismatch for ${relative}`)
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('an unknown architecture is refused rather than guessed', () => {
	const { dir, binary } = fakeBinary()

	try {
		assert.throws(
			() => packageDeb({ appDir, binaryPath: binary, rustArch: 'mips', outputDir: dir }),
			/No Debian package name is known for mips/,
		)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('the tarball unpacks under a single versioned directory', () => {
	const { dir, binary } = fakeBinary()

	try {
		const archivePath = packageTarball({
			appDir,
			binaryPath: binary,
			outputDir: path.join(dir, 'out'),
		})
		const listing = execFileSync('tar', ['tzf', archivePath], { encoding: 'utf8' })
		const roots = new Set(
			listing
				.split('\n')
				.filter(Boolean)
				.map((entry) => entry.split('/')[0]),
		)
		// Everything under one directory: extracting into the home directory
		// must not scatter files across it.
		assert.deepEqual([...roots], ['AxolotlLauncher_1.9.7'])
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('AppImage is only claimed where a runtime exists', () => {
	// An AppImage embeds a prebuilt runtime interpreter. linuxdeploy publishes
	// one for these four architectures only, so claiming otherwise would
	// promise a package that cannot be built.
	for (const arch of ['x86_64', 'aarch64', 'x86', 'riscv64', 'loongarch64']) {
		const names = archPackageNames(arch)
		assert.ok(names, `${arch} should have package names`)
	}

	assert.equal(hasAppImageRuntime('x86_64'), true)
	assert.equal(hasAppImageRuntime('aarch64'), true)
	// No runtime is published for these, so no AppImage can be made honestly.
	assert.equal(hasAppImageRuntime('riscv64'), false)
	assert.equal(hasAppImageRuntime('loongarch64'), false)
	assert.equal(hasAppImageRuntime('mips'), false)
})

test('every packageable architecture has a deb name', () => {
	for (const arch of debPackagedArches()) {
		const names = archPackageNames(arch)
		assert.ok(names.deb, `${arch} is listed as deb-packaged but has no deb name`)
	}
})