#!/bin/sh
# Builds a cross-compile environment for a Debian architecture, without root.
#
#   setup-cross-sysroot.sh <debian-arch> <rust-target> <suite> <root-package>...
#
# Writes an `env.sh` next to the sysroot that callers `source` or append to
# `$GITHUB_ENV`. The default location is /tmp/opencode/cross; set CROSS_BASE to
# place it elsewhere.
#
# Two package indexes are involved. The cross toolchain
# (gcc-<triplet>-linux-gnu, binutils-<triplet>-linux-gnu) is published in the
# amd64 index and is host-runnable; the target libraries
# (libwebkit2gtk-4.1-dev for riscv64, ...) live in the target architecture's own
# index. Package names collide between the two -- `gcc-14-riscv64-linux-gnu`
# names both the cross compiler and the native riscv64 gcc -- so the resolver
# keeps them apart by index and unpacks host packages into a separate prefix.
set -eu

ARCH=${1:?usage: setup-cross-sysroot.sh <debian-arch> <rust-target> <suite> [root-package...]}
TARGET=${2:?usage: setup-cross-sysroot.sh <debian-arch> <rust-target> <suite> [root-package...]}
shift 2

# riscv64 is an official trixie architecture. loong64 only becomes official in
# Debian 14, so its webkit2gtk stack is published from sid.
SUITE=${1:?usage: setup-cross-sysroot.sh <debian-arch> <rust-target> <suite> [root-package...]}
shift
case $SUITE in
trixie | sid) ;;
*)
	echo "unknown suite $SUITE" >&2
	exit 1
	;;
esac

BASE=${CROSS_BASE:-/tmp/opencode/cross}/$ARCH-$SUITE
SYSROOT=$BASE/sysroot
HOSTROOT=$BASE/hostroot
XBIN=$BASE/xbin
XLIB=$BASE/xlib
TRIPLET=$ARCH-linux-gnu
MIRROR=https://deb.debian.org/debian

mkdir -p "$BASE" "$SYSROOT" "$HOSTROOT" "$XBIN" "$XLIB"

# ── Package indexes ────────────────────────────────────────────────────────
fetch_index() {
	dest=$BASE/Packages.$1
	[ -s "$dest" ] && return 0
	for ext in xz gz; do
		if curl -sfL "$MIRROR/dists/$SUITE/main/binary-$1/Packages.$ext" \
			| (case $ext in xz) xz -dc ;; *) gzip -dc ;; esac) > "$dest.tmp"
		then
			mv "$dest.tmp" "$dest"
			echo "index $1: $(wc -l < "$dest") lines"
			return 0
		fi
	done
	rm -f "$dest.tmp"
	echo "no $SUITE package index for $1" >&2
	return 1
}

# The target index must be read first; the host index only contributes
# toolchain packages and host-runnable libraries.
fetch_index "$ARCH"
fetch_index amd64

# Debian is inconsistent about the loong64 triplet: the C library packages use
# `loong64-*` while gcc and binutils use `loongarch64-*`. Use whichever spelling
# actually carries the toolchain.
if ! grep -q "^Package: binutils-$TRIPLET\$" "$BASE/Packages.amd64"; then
	echo "no binutils-$TRIPLET in the host index; trying loongarch64" >&2
	TRIPLET=loongarch64-linux-gnu
fi

# ── Resolve and unpack the dependency closure ──────────────────────────────
# Host packages the cross tools dynamically link against. Without these the
# cross `as` fails on a missing libsframe.so.1.
HOST_PACKAGES="binutils-common libbinutils libctf0 libctf-nobfd0 libsframe1
zlib1g libzstd1 liblzma5 libbz2-1.0 libgmp10 libmpfr6 libmpc3 libisl23
libstdc++6 libgcc-s1 libc6"

SUITE=$SUITE HOST_PACKAGES="$HOST_PACKAGES" node - "$ARCH" "$TRIPLET" "$BASE" "$@" <<'EOF'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [arch, triplet, base, ...roots] = process.argv.slice(2)
// Host packages arrive as one space-separated string: they must be unpacked
// into the host prefix rather than the target sysroot.
const hostPackages = (process.env.HOST_PACKAGES ?? '').split(/\s+/).filter(Boolean)
const MIRROR = 'https://deb.debian.org/debian'
const SUITE = process.env.SUITE ?? 'trixie'

function parseIndex(file) {
	const map = new Map()
	for (const block of fs.readFileSync(file, 'utf8').split('\n\n')) {
		if (!block.trim()) continue
		const fields = {}
		let key = null
		for (const line of block.split('\n')) {
			if (/^\s/.test(line) && key) {
				fields[key] += `\n${line.trim()}`
			} else {
				const i = line.indexOf(':')
				if (i === -1) continue
				key = line.slice(0, i)
				fields[key] = line.slice(i + 1).trim()
			}
		}
		if (fields.Package && fields.Filename) map.set(fields.Package, fields)
	}
	return map
}

const targetIndex = parseIndex(path.join(base, `Packages.${arch}`))
const hostIndex = parseIndex(path.join(base, 'Packages.amd64'))

// Cross toolchain packages are named after the target triplet and exist twice
// under one name: in the target index as a native build that cannot run on the
// build host, and in the amd64 index as the cross build that can.
const isToolchain = (name) =>
	name.includes(`${arch}-linux-gnu`) || name.includes(`${triplet}`)
const lookup = (name, preferHost) =>
	(preferHost || isToolchain(name)
		? hostIndex.get(name)
		: targetIndex.get(name)) ?? targetIndex.get(name) ?? hostIndex.get(name)

const resolved = new Map()
const missing = []
const queue = [
	...roots.map((n) => [n, false]),
	...hostPackages.map((n) => [n, true]),
]

while (queue.length > 0) {
	const [raw, preferHost] = queue.shift()
	const name = raw.split(':')[0]
	if (resolved.has(name)) continue
	resolved.set(name, preferHost)

	const pkg = lookup(name, preferHost)
	if (!pkg) {
		missing.push(name)
		continue
	}
	for (const dep of (pkg.Depends ?? '').split(',')) {
		const depName = dep.split('|')[0].trim().split(' ')[0].split(':')[0]
		if (depName && !resolved.has(depName)) queue.push([depName, preferHost])
	}
}

// A .deb is an `ar` archive; unpack its data member with the available
// decompressor. `dpkg-deb` is not assumed to be present.
function extract(debPath, target) {
	debPath = path.resolve(debPath)
	target = path.resolve(target)
	const member = execFileSync('ar', ['t', debPath], { encoding: 'utf8' })
		.split('\n')
		.map((l) => l.trim())
		.find((n) => n.startsWith('data.tar'))
	if (!member) throw new Error('no data member')

	const scratch = fs.mkdtempSync(path.join(base, 'x-'))
	try {
		execFileSync('ar', ['x', debPath, member], { cwd: scratch })
		const file = path.join(scratch, member)
		const decompress = member.endsWith('.xz')
			? 'xz -dc'
			: member.endsWith('.gz')
				? 'gzip -dc'
				: member.endsWith('.zst')
					? 'zstd -dc'
					: 'cat'
		execFileSync('sh', [
			'-c',
			`${decompress} '${file}' | tar -x -C '${target}'`,
		])
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true })
	}
}

let count = 0
for (const [name, preferHost] of resolved) {
	const pkg = lookup(name, preferHost)
	if (!pkg) continue
	const dest = path.join(base, 'debs', path.basename(pkg.Filename))
	fs.mkdirSync(path.dirname(dest), { recursive: true })
	try {
		if (!fs.existsSync(dest)) {
			// Filename is a pool/... path relative to the archive root. The pool is
			// shared across suites, so it must not be prefixed with the suite.
			const res = await fetch(`${MIRROR}/${pkg.Filename}`)
			if (!res.ok) throw new Error(`http ${res.status}`)
			fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
		}
		// Host packages must not land in the target sysroot: they would
		// overwrite target libc with an x86_64 copy.
		extract(dest, preferHost ? path.join(base, 'hostroot') : path.join(base, 'sysroot'))
		count++
	} catch (error) {
		missing.push(`${name} (${error.message})`)
	}
}

console.log(`unpacked ${count} packages`)
if (missing.length > 0) {
	// gobject-introspection .dev names and a few virtual packages are expected
	// to be absent; they are not needed to link the launcher.
	console.log(`absent ${missing.length}: ${missing.slice(0, 12).join(', ')}`)
}
EOF

# ── Host-runnable cross tools ──────────────────────────────────────────────
# Only symlink binaries that are x86_64, so the target's own tools (which cannot
# execute here) are never picked up by mistake.
for tool in gcc g++ cpp ld as ar nm ranlib strip objcopy c++filt gcc-ar gcc-nm gcc-ranlib; do
	src=$SYSROOT/usr/bin/$TRIPLET-$tool
	[ -e "$src" ] || continue
	real=$(realpath "$src")
	case $(file -b "$real") in
	*x86-64*) ln -sf "$real" "$XBIN/$TRIPLET-$tool" ;;
	esac
done

# The cross binutils link against their own shared objects, which are not on the
# build host by default. Collect exactly those rather than putting a whole
# library directory on LD_LIBRARY_PATH.
for lib in "$SYSROOT"/usr/lib/x86_64-linux-gnu/*"$ARCH"*linux-gnu*.so*; do
	[ -e "$lib" ] && ln -sf "$(realpath "$lib")" "$XLIB/$(basename "$lib")"
done
for name in libsframe libzstd liblzma; do
	for lib in "$HOSTROOT"/usr/lib/x86_64-linux-gnu/$name*.so*; do
		[ -e "$lib" ] && ln -sf "$(realpath "$lib")" "$XLIB/$(basename "$lib")"
	done
done

# ── Compiler wrapper ───────────────────────────────────────────────────────
# Debian's cross gcc resolves the loader and target libc through absolute paths
# that only exist when the sysroot is mounted at `/`, so the link step needs an
# explicit sysroot and library search path.
cat > "$XBIN/$TRIPLET-gccw" <<WRAPPER
#!/bin/sh
set -e
exec "$XBIN/$TRIPLET-gcc" \\
	-B"$XBIN/" \\
	-Wl,--sysroot="$SYSROOT" \\
	-L"$SYSROOT/usr/$TRIPLET/lib" \\
	-L"$SYSROOT/usr/lib/$TRIPLET" \\
	"\$@"
WRAPPER
chmod +x "$XBIN/$TRIPLET-gccw"

# ── Environment ────────────────────────────────────────────────────────────
# `env.sh` is written for `source` or for appending to `$GITHUB_ENV`, so every
# path is written as a variable reference rather than an expanded literal.
ENV_UPPER=$(echo "$TARGET" | tr 'a-z-' 'A-Z_')
cat > "$BASE/env.sh" <<ENVFILE
export CROSS_BASE="$BASE"
export XBIN="$XBIN"
export XLIB="$XLIB"
export SYSROOT="$SYSROOT"
export HOSTROOT="$HOSTROOT"
export TRIPLET="$TRIPLET"
export TARGET="$TARGET"
# Only \$XBIN goes on PATH. The sysroot's own bin directory holds $ARCH
# binaries (sed, pkg-config, ...) that cannot execute on the x86_64 host.
export PATH="\$XBIN:\$PATH"
export LD_LIBRARY_PATH="\$XLIB:\$SYSROOT/usr/lib/x86_64-linux-gnu"
export PKG_CONFIG_SYSROOT_DIR="\$SYSROOT"
export PKG_CONFIG_LIBDIR="\$SYSROOT/usr/lib/\$TRIPLET/pkgconfig:\$SYSROOT/usr/share/pkgconfig"
export CC_${ENV_UPPER}="\$XBIN/\$TRIPLET-gccw"
export CXX_${ENV_UPPER}="\$XBIN/\$TRIPLET-gccw"
export AR_${ENV_UPPER}="\$XBIN/\$TRIPLET-ar"
export CARGO_TARGET_${ENV_UPPER}_LINKER="\$XBIN/\$TRIPLET-gccw"
export SQLX_OFFLINE=true
export AXOLOTL_SKIP_BLOCKBENCH_BUILD=1
ENVFILE

# ── Verify ─────────────────────────────────────────────────────────────────
if . "$BASE/env.sh"; then
	printf 'int main(void){return 0;}\n' > "$BASE/probe.c"
	if "$XBIN/$TRIPLET-gccw" "$BASE/probe.c" -o "$BASE/probe" 2>"$BASE/probe.log"; then
		echo "probe: $(file -b "$BASE/probe" | cut -d, -f1-2)"
	else
		echo "probe FAILED:" >&2
		cat "$BASE/probe.log" >&2
		exit 1
	fi
	if pkg-config --exists webkit2gtk-4.1; then
		echo "webkit2gtk-4.1: found"
	else
		echo "webkit2gtk-4.1: MISSING" >&2
	fi
fi
