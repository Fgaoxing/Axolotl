// Packages a cross-compiled Linux launcher for a release and uploads it.
//
// This is the release-time counterpart to `bundle-linux.mjs`, which does the
// packaging. tauri-bundler cannot package riscv64 or loongarch64: its `Arch`
// enum has no LoongArch variant, `binary_arch()` panics on an unrecognised
// target triple, and its AppImage backend rejects riscv64. The workflow
// therefore builds with `tauri build --no-bundle` and calls this instead.
//
// The steps mirror what `tauri-action` does for the architectures tauri-bundler
// does support, so the resulting release assets are indistinguishable to the
// Update Server and the updater manifest:
//
//  1. build the executable      (done by `tauri build --no-bundle`)
//  2. package it                (bundle-linux.mjs)
//  3. sign it with minisign     (`tauri signer sign`)
//  4. upload it to the release  (`gh release upload`)

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
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

function run(command, args, options = {}) {
	// Inherit stdio so a signing failure surfaces its message in the job log.
	return execFileSync(command, args, { stdio: 'inherit', ...options })
}

/**
 * Locates the executable `tauri build --no-bundle` produced for a target.
 *
 * @param {string} repositoryRoot
 * @param {string} target Rust target triple
 * @returns {string}
 */
function findBinary(repositoryRoot, target) {
	const directory = path.join(repositoryRoot, 'target', target, 'release')
	const config = JSON.parse(
		fs.readFileSync(path.join(repositoryRoot, 'apps/app/tauri.conf.json'), 'utf8'),
	)
	const binaryName = config.mainBinaryName ?? config.productName
	const binaryPath = path.join(directory, binaryName)

	if (!fs.existsSync(binaryPath)) {
		throw new Error(
			`No executable at ${binaryPath}. Run \`tauri build --target ${target} --no-bundle\` first.`,
		)
	}
	return binaryPath
}

/**
 * Signs a file with the launcher's updater key and returns the `.sig` path.
 *
 * @returns {string}
 */
function sign(repositoryRoot, file) {
	const appDir = path.join(repositoryRoot, 'apps/app')

	// Invoke the app workspace's own Tauri CLI. `pnpm tauri` from the repository
	// root does not resolve it, and the CLI is what implements minisign.
	const cli = path.join(appDir, 'node_modules/.bin/tauri')
	if (!fs.existsSync(cli)) {
		throw new Error(`No Tauri CLI at ${cli}. Run \`pnpm install\` first.`)
	}

	// `--app-version` binds the signature to this version. It only exists in
	// newer CLIs (tauri PR #16063); on an older one the signature still
	// verifies, so fall back rather than failing the release.
	const args = ['signer', 'sign']
	if (supportsAppVersion(cli)) args.push('--app-version', readVersion(repositoryRoot))
	args.push(file)

	run(cli, args, {
		cwd: appDir,
		env: {
			...process.env,
			// `tauri signer sign` reads both from the environment. Failing here
			// is better than signing with an empty key.
			TAURI_SIGNING_PRIVATE_KEY: requiredEnv('TAURI_SIGNING_PRIVATE_KEY'),
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
		},
	})
	return `${file}.sig`
}

function requiredEnv(name) {
	const value = process.env[name]
	if (!value) {
		throw new Error(`${name} is not set, so the package cannot be signed`)
	}
	return value
}

/**
 * Whether the installed CLI accepts `--app-version`.
 *
 * @param {string} cli path to the Tauri CLI
 * @returns {boolean}
 */
function supportsAppVersion(cli) {
	const help = execFileSync(cli, ['signer', 'sign', '--help'], { encoding: 'utf8' })
	return help.includes('--app-version')
}

function readVersion(repositoryRoot) {
	return JSON.parse(
		fs.readFileSync(path.join(repositoryRoot, 'apps/app-frontend/package.json'), 'utf8'),
	).version
}

/**
 * Packages, signs, and uploads a cross-compiled Linux target.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string} options.target Rust target triple
 * @param {string} options.rustArch `std::env::consts::ARCH` name of the build
 * @param {string} options.tag release tag to upload to
 * @returns {string[]} paths of the uploaded files
 */
export function publishLinuxTarget({ repositoryRoot, target, rustArch, tag }) {
	const names = archPackageNames(rustArch)
	if (!names) {
		throw new Error(`No package names are known for ${rustArch}`)
	}

	const binaryPath = findBinary(repositoryRoot, target)
	const outputDir = path.join(repositoryRoot, 'target', target, 'release', 'bundle', 'deb')
	const debPath = packageDeb({ appDir: path.join(repositoryRoot, 'apps/app'), binaryPath, rustArch, outputDir })
	const signaturePath = sign(repositoryRoot, debPath)

	run('gh', ['release', 'upload', tag, debPath, signaturePath, '--clobber'], {
		cwd: repositoryRoot,
		env: { ...process.env, GH_TOKEN: requiredEnv('GH_TOKEN') },
	})

	return [debPath, signaturePath]
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href

if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2))
	for (const name of ['target', 'arch', 'tag']) {
		if (!args[name]) {
			throw new Error(`Missing required --${name}`)
		}
	}

	const uploaded = publishLinuxTarget({
		repositoryRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
		target: args.target,
		rustArch: args.arch,
		tag: args.tag,
	})
	console.log(`uploaded ${uploaded.length} files`)
}