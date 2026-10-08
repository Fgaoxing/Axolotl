// Builds a package for a cross-compiled Linux target and checks its contents.
//
// Used by CI to keep the cross-architecture packaging path honest. A
// `cargo check` alone would pass even if every packaging step were broken,
// and the release job runs only for tags, so the failure would otherwise
// surface on the first release that needed it.
//
// This is the unsigned counterpart of `package-linux-target.mjs`: it stops
// before signing and uploading, because a pull request has no signing key.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { archPackageNames } from './arch_package_names.mjs'
import { packageDeb } from './bundle-linux.mjs'

/**
 * Parses `--flag value` arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
	const args = {}
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith('--')) {
			throw new Error(`Expected a --flag, got ${argv[i]}`)
		}
		args[argv[i].slice(2)] = argv[i + 1]
	}
	return args
}

/**
 * Reports the architecture of a file, as `file(1)` describes it.
 *
 * @param {string} filePath
 * @returns {string}
 */
function describeBinary(filePath) {
	return execFileSync('file', ['-b', filePath], { encoding: 'utf8' }).trim()
}

/**
 * Builds and verifies a package for a cross-compiled target.
 *
 * @param {object} options
 * @returns {string} the path of the built package
 */
export function verifyLinuxPackage({ repositoryRoot, target, rustArch, version }) {
	const names = archPackageNames(rustArch)
	if (!names) {
		throw new Error(`No package names are known for ${rustArch}`)
	}

	const appDir = path.join(repositoryRoot, 'apps/app')
	const config = JSON.parse(fs.readFileSync(path.join(appDir, 'tauri.conf.json'), 'utf8'))
	const binaryName = config.mainBinaryName ?? config.productName
	const binaryPath = path.join(repositoryRoot, 'target', target, 'release', binaryName)

	if (!fs.existsSync(binaryPath)) {
		throw new Error(
			`No executable at ${binaryPath}. Run \`cargo build --release --target ${target}\` first.`,
		)
	}

	// Confirm the binary really is for the requested architecture. A stale
	// executable from another target would otherwise be packaged and shipped
	// under the wrong name.
	const description = describeBinary(binaryPath)
	const expected = { riscv64: 'RISC-V', loongarch64: 'LoongArch' }[rustArch]
	if (expected && !description.includes(expected)) {
		throw new Error(`${binaryPath} is not a ${expected} executable: ${description}`)
	}

	// Keep the package beside the executable so the build tree holds the only
	// artifacts, matching where tauri-bundler writes its bundles.
	const bundleDir = path.join(repositoryRoot, 'target', target, 'release', 'bundle', 'deb')
	const debPath = packageDeb({ appDir, binaryPath, rustArch, outputDir: bundleDir })
	const expectedName = `Axolotl Launcher_${version}_${names.deb}.deb`
	if (path.basename(debPath) !== expectedName) {
		throw new Error(`Expected ${expectedName}, built ${path.basename(debPath)}`)
	}

	// Read the control file back out of the archive: the metadata is what apt
	// selects on, so a wrong architecture here installs nothing at all.
	const control = execFileSync('sh', ['-c', `ar p '${debPath}' control.tar.gz | tar xzOf - control`], {
		encoding: 'utf8',
	})
	if (!new RegExp(`^Architecture: ${names.deb}$`, 'm').test(control)) {
		throw new Error(`Package does not declare Architecture: ${names.deb}\n${control}`)
	}

	// Extract into the system temp directory rather than the build tree, so a
	// failure cannot leave a partly-extracted copy next to the executable.
	const payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axolotl-verify-'))
	try {
		execFileSync('sh', ['-c', `ar p '${debPath}' data.tar.gz | tar xzf - -C '${payloadDir}'`])
		const installedBinary = path.join(payloadDir, 'usr/bin', binaryName)
		if (!fs.existsSync(installedBinary)) {
			throw new Error(`Package does not install ${installedBinary}`)
		}
		if (!fs.existsSync(path.join(payloadDir, 'usr/share/applications', `${config.productName}.desktop`))) {
			throw new Error('Package installs no desktop entry, so it would be unlaunchable')
		}
		// The payload must be the executable that was built, not a stale copy
		// left in the tree by an earlier run.
		if (fs.readFileSync(installedBinary).compare(fs.readFileSync(binaryPath)) !== 0) {
			throw new Error('Packaged executable differs from the built one')
		}
	} finally {
		fs.rmSync(payloadDir, { recursive: true, force: true })
	}

	return debPath
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href

if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2))
	for (const name of ['target', 'arch', 'version']) {
		if (!args[name]) {
			throw new Error(`Missing required --${name}`)
		}
	}

	const built = verifyLinuxPackage({
		repositoryRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
		target: args.target,
		rustArch: args.arch,
		version: args.version,
	})
	console.log(`verified ${built}`)
}