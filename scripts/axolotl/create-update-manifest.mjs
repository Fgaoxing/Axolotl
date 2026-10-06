import fs from 'node:fs'
import path from 'node:path'

import { updaterTargets } from './updater_platforms.mjs'

const [releasePath, signaturesPath, tag, outputPath] = process.argv.slice(2)

if (!releasePath || !signaturesPath || !tag || !outputPath) {
	throw new Error(
		'Usage: node create-update-manifest.mjs <release.json> <signatures-dir> <version-tag> <output.json>',
	)
}

const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
const assets = release.assets

if (!Array.isArray(assets)) {
	throw new Error('Release metadata does not contain an assets array')
}

// Each entry pairs the manifest's platform keys with the release asset that
// serves them. Linux is built per architecture, so its AppImage suffix carries
// the Debian architecture name; macOS ships one universal binary, and Windows a
// single installer, so those suffixes describe the packaging rather than a
// specific CPU.
//
// `updater_platforms.mjs` is the single source of this table. The Update Server
// and the CNB mirror both re-derive the same key set, so they import it too.
const targets = updaterTargets

const platforms = {}

for (const target of targets) {
	const matches = assets.filter((asset) => asset.name?.endsWith(target.assetSuffix))
	if (matches.length !== 1) {
		throw new Error(
			`Expected one release asset ending in ${target.assetSuffix}, found ${matches.length}`,
		)
	}

	const asset = matches[0]
	const signaturePath = path.join(signaturesPath, `${asset.name}.sig`)
	if (!fs.existsSync(signaturePath)) {
		throw new Error(`Missing updater signature ${path.basename(signaturePath)}`)
	}

	const signature = fs.readFileSync(signaturePath, 'utf8')
	const url = asset.browser_download_url ?? asset.url
	if (!url) {
		throw new Error(`Release asset ${asset.name} does not contain a download URL`)
	}

	for (const platform of target.platforms) {
		platforms[platform] = { signature, url }
	}
}

const manifest = {
	version: tag.replace(/^v/, ''),
	notes: release.body ?? '',
	pub_date: new Date().toISOString(),
	platforms,
}

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
