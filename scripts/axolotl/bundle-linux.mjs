// Packages a Linux launcher binary for architectures tauri-bundler cannot
// bundle.
//
// tauri-bundler's `Arch` enum has no LoongArch variant, and `binary_arch()`
// panics on an unrecognised target triple, so `tauri build` aborts after a
// successful compile. The CLI is distributed as a prebuilt binary, so the enum
// cannot be patched from this repository's `[patch.crates-io]` either.
//
// The way out is `tauri build --no-bundle`, which stops after producing the
// (correctly cross-compiled) executable, and build the package here. Both
// formats below are plain archives assembled with `ar` and `tar`, so they need
// no bundler support for the architecture at all.
//
// Not produced here: AppImage. Its format embeds a prebuilt runtime
// interpreter, and linuxdeploy/AppImage only publish runtimes for x86_64,
// i386, armhf and aarch64. There is no riscv64 or loongarch64 runtime to embed,
// so an AppImage for these architectures cannot be made honest.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { archPackageNames } from './arch_package_names.mjs'

/**
 * Reads the fields out of tauri.conf.json that the package layout depends on.
 *
 * @param {string} appDir
 * @returns {{productName: string, mainBinaryName: string, resources: string[], debDepends: string[], icons: string[], version: string}}
 */
function readTauriConfig(appDir) {
	const configPath = path.join(appDir, 'tauri.conf.json')
	const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

	// `version` is a path relative to tauri.conf.json, pointing at the frontend
	// package that owns the real version string.
	const versionSource = path.resolve(appDir, config.version)
	const version = JSON.parse(fs.readFileSync(versionSource, 'utf8')).version

	return {
		productName: config.productName,
		mainBinaryName: config.mainBinaryName ?? config.productName,
		resources: config.bundle.resources ?? [],
		debDepends: config.bundle.linux?.deb?.depends ?? [],
		// Only the configured icons, so this installs the same set
		// tauri-bundler would rather than every PNG in the directory (which
		// includes Windows Store logos that have no place in a Linux package).
		icons: (config.bundle.icon ?? []).filter((icon) => icon.endsWith('.png')),
		version,
	}
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		...options,
	})
}

/**
 * Builds the directory tree a Debian or RPM package installs.
 *
 * Paths follow what tauri-bundler produces for the architectures it does
 * support, so a package built here is laid out identically to one it built:
 * the executable in `usr/bin`, bundled resources under `usr/lib/<product>`,
 * and the desktop entry and icons in `usr/share`.
 *
 * @param {object} options
 * @returns {string} the staging directory
 */
function stagePayload({ appDir, binaryPath, workDir, config }) {
	const stage = path.join(workDir, 'data')
	fs.mkdirSync(path.join(stage, 'usr/bin'), { recursive: true })

	fs.copyFileSync(binaryPath, path.join(stage, 'usr/bin', config.mainBinaryName))

	// Bundled resources ship beside the executable under the product directory.
	for (const resource of config.resources) {
		const source = path.join(appDir, resource)
		if (!fs.existsSync(source)) {
			// tauri-build validates resources during the build, so a missing one
			// here means the build already reported it. Skipping keeps this
			// script from duplicating that check with a worse message.
			continue
		}
		const destination = path.join(stage, 'usr/lib', config.productName, resource)
		fs.mkdirSync(path.dirname(destination), { recursive: true })
		fs.cpSync(source, destination, { recursive: true })
	}

	const desktopEntry = `[Desktop Entry]
Type=Application
Name=${config.productName}
Comment=A Minecraft launcher
Exec=${config.mainBinaryName}
Icon=${config.productName}
Terminal=false
Categories=Game;
MimeType=application/x-modrinth-modpack+zip;
`
	fs.mkdirSync(path.join(stage, 'usr/share/applications'), { recursive: true })
	fs.writeFileSync(
		path.join(stage, 'usr/share/applications', `${config.productName}.desktop`),
		desktopEntry,
	)

	// Install only the configured icons, into the hicolor size directories the
	// desktop entry's `Icon=` resolves through. A `128x128@2x.png` icon names
	// the 256px slot, matching the hicolor convention.
	for (const icon of config.icons) {
		const name = path.basename(icon)
		// `128x128.png` and `128x128@2x.png` both name a size; the `@2x`
		// suffix means the file is twice the base resolution.
		const match = /^(\d+)x\d+(?:@(\d+)x)?\.png$/.exec(name)
		if (!match) continue

		const size = Number(match[1]) * (match[2] ? Number(match[2]) : 1)
		const destination = path.join(
			stage,
			`usr/share/icons/hicolor/${size}x${size}/apps/${config.productName}.png`,
		)
		fs.mkdirSync(path.dirname(destination), { recursive: true })
		fs.copyFileSync(path.join(appDir, icon), destination)
	}

	return stage
}

/**
 * The installed size in KiB that a Debian control file must declare.
 *
 * @param {string} stage
 * @returns {number}
 */
function installedSizeKiB(stage) {
	let total = 0
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.isFile()) total += fs.statSync(full).size
		}
	}
	walk(stage)
	// dpkg rounds up to whole 1 KiB blocks.
	return Math.ceil(total / 1024)
}

/**
 * Assembles a .deb around an already-staged payload.
 *
 * The format is documented in deb-binary(5): a fixed `debian-binary` member
 * naming the format version, then `control.tar.gz` holding metadata, then
 * `data.tar.gz` holding the payload, wrapped in a Unix `ar` archive.
 *
 * @returns {string} the path of the written package
 */
function buildDeb({ stage, workDir, config, arch }) {
	const controlDir = path.join(workDir, 'control')
	fs.mkdirSync(controlDir, { recursive: true })

	const control = `Package: ${config.productName.toLowerCase().replace(/\s+/g, '-')}
Version: ${config.version}
Architecture: ${arch}
Installed-Size: ${installedSizeKiB(stage)}
Maintainer: ghs
Priority: optional
Section: games
Homepage: https://www.ghs.red
Depends: ${config.debDepends.join(', ')}
Description: ${config.productName}
 A Minecraft launcher.
`
	fs.writeFileSync(path.join(controlDir, 'control'), control)

	// dpkg verifies the payload against md5sums, and its absence makes some
	// tools treat the package as malformed even though dpkg itself tolerates it.
	const md5sums = run('find', ['.', '-type', 'f'], { cwd: stage })
		.split('\n')
		.filter(Boolean)
		.map((relative) => {
			const absolute = path.join(stage, relative)
			const digest = run('md5sum', [absolute]).split(/\s+/)[0]
			return `${digest}  ${relative.replace(/^\.\//, '')}`
		})
		.sort()
		.join('\n')
	fs.writeFileSync(path.join(controlDir, 'md5sums'), `${md5sums}\n`)

	const buildDir = path.join(workDir, 'deb')
	fs.mkdirSync(buildDir, { recursive: true })
	run('tar', ['-czf', 'control.tar.gz', '-C', controlDir, 'control', 'md5sums'], {
		cwd: buildDir,
	})
	run('tar', ['-czf', 'data.tar.gz', '-C', stage, '.'], { cwd: buildDir })
	fs.writeFileSync(path.join(buildDir, 'debian-binary'), '2.0\n')

	const output = path.join(
		workDir,
		`${config.productName}_${config.version}_${arch}.deb`,
	)
	// `ar` is deterministic by default; passing D avoids embedding mtimes that
	// would make two builds of the same source differ.
	run('ar', [
		'rcD',
		output,
		path.join(buildDir, 'debian-binary'),
		path.join(buildDir, 'control.tar.gz'),
		path.join(buildDir, 'data.tar.gz'),
	])

	return output
}

/**
 * Packages a cross-compiled launcher binary as a .deb.
 *
 * @param {object} options
 * @param {string} options.appDir directory holding tauri.conf.json
 * @param {string} options.binaryPath the executable produced by the build
 * @param {string} options.rustArch `std::env::consts::ARCH` name of the build
 * @param {string} options.outputDir directory the finished package is written to
 * @returns {string} the path of the written package
 */
export function packageDeb({ appDir, binaryPath, rustArch, outputDir }) {
	const names = archPackageNames(rustArch)
	if (!names) {
		throw new Error(`No Debian package name is known for ${rustArch}`)
	}

	const config = readTauriConfig(appDir)
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axolotl-deb-'))

	try {
		const stage = stagePayload({ appDir, binaryPath, workDir, config })
		const built = buildDeb({ stage, workDir, config, arch: names.deb })

		fs.mkdirSync(outputDir, { recursive: true })
		const output = path.join(outputDir, path.basename(built))
		// The scratch directory is on a different filesystem from the build
		// tree, which a rename cannot cross, so copy the finished package out
		// before the scratch directory is removed.
		fs.copyFileSync(built, output)
		return output
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true })
	}
}

/**
 * Packages a cross-compiled launcher binary as a plain gzipped tarball.
 *
 * This is the fallback for an architecture with no package format available:
 * it is what `linuxdeploy` would wrap into an AppImage, kept unpackable so the
 * user can run the launcher from it directly.
 *
 * @param {object} options
 * @param {string} options.appDir directory holding tauri.conf.json
 * @param {string} options.binaryPath the executable produced by the build
 * @param {string} options.outputDir directory the finished archive is written to
 * @returns {string} the path of the written archive
 */
export function packageTarball({ appDir, binaryPath, outputDir }) {
	const config = readTauriConfig(appDir)
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axolotl-tar-'))

	try {
		const stage = stagePayload({ appDir, binaryPath, workDir, config })
		// The archive unpacks into a single versioned directory, matching the
		// shape of Tauri's own `.tar.gz` updater artifacts.
		const root = `${config.productName.replace(/\s+/g, '')}_${config.version}`
		const built = path.join(workDir, `${root}.tar.gz`)
		run('tar', ['-czf', built, '--transform', `s,^\\.,${root},`, '-C', stage, '.'])

		fs.mkdirSync(outputDir, { recursive: true })
		const output = path.join(outputDir, path.basename(built))
		// See packageDeb: the scratch directory is on another filesystem.
		fs.copyFileSync(built, output)
		return output
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true })
	}
}