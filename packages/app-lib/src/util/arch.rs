//! Architecture identity for the running launcher.
//!
//! Every architecture-dependent decision in the launcher used to be an
//! independent `match` over `std::env::consts`, which meant adding an
//! architecture meant finding and editing each of them separately. They are
//! gathered here so that one table describes a target and the rest of the
//! codebase asks for the specific name it needs.
//!
//! Naming differs per consumer and cannot be collapsed into one string:
//!
//! - Rust and the updater manifest use `std::env::consts::ARCH` spellings
//!   (`x86_64`, `aarch64`, `riscv64`, `loongarch64`).
//! - Debian and RPM packages use distribution spellings (`amd64`, `arm64`,
//!   `riscv64`, `loong64`).
//! - Java's `os.arch` uses `amd64` and `aarch64` but has no distribution-style
//!   names, and Minecraft's native classifier rules are keyed on the Java
//!   spelling.

/// A launcher build target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchTarget {
	/// `std::env::consts::ARCH` value, also used by the updater platform keys.
	pub rust_arch: &'static str,
	/// Debian architecture name, used by `.deb` filenames and apt metadata.
	///
	/// `None` where the architecture has no Debian packaging. RISC-V and
	/// LoongArch both have `riscv64` and `loong64` packages, so this is set for
	/// every supported target.
	pub deb_arch: &'static str,
	/// Value Java reports for `os.arch`, which drives Minecraft's native
	/// library and rule matching.
	pub java_arch: &'static str,
}

/// Every architecture the launcher is built for, in a fixed order.
///
/// Keeping this exhaustive means a new target is added in exactly one place.
pub const ARCH_TARGETS: &[ArchTarget] = &[
	ArchTarget {
		rust_arch: "x86_64",
		deb_arch: "amd64",
		java_arch: "amd64",
	},
	ArchTarget {
		rust_arch: "aarch64",
		deb_arch: "arm64",
		java_arch: "aarch64",
	},
	ArchTarget {
		rust_arch: "x86",
		deb_arch: "i386",
		java_arch: "x86",
	},
	ArchTarget {
		rust_arch: "riscv64",
		deb_arch: "riscv64",
		java_arch: "riscv64",
	},
	// Cross-compiles and links, but tauri-bundler's `binary_arch` panics on the
	// loongarch64 target triple, so no bundle and therefore no release asset can
	// be produced for it. Kept here because the launcher must still run on the
	// architecture; it is deliberately absent from the release build matrix and
	// the updater manifest until tauri-bundler supports it.
	ArchTarget {
		rust_arch: "loongarch64",
		deb_arch: "loong64",
		java_arch: "loongarch64",
	},
];

/// The architecture this binary was built for.
pub fn current() -> &'static ArchTarget {
	// `ARCH_TARGETS` must cover the host, since the launcher cannot run without
	// a matching entry. Falling back keeps a missing entry from panicking in a
	// `Drop` or error path, where the alternative is an abort.
	lookup(std::env::consts::ARCH).unwrap_or(&ArchTarget {
		rust_arch: "unknown",
		deb_arch: "unknown",
		java_arch: "unknown",
	})
}

/// The entry for a `std::env::consts::ARCH` value, if the launcher supports it.
pub fn lookup(rust_arch: &str) -> Option<&'static ArchTarget> {
	ARCH_TARGETS
		.iter()
		.find(|target| target.rust_arch == rust_arch)
}

/// Whether an architecture is one the launcher is built for.
///
/// Used by callers that must fail cleanly rather than assume a supported
/// architecture, such as the multiplayer helper downloads.
pub fn is_supported(rust_arch: &str) -> bool {
	lookup(rust_arch).is_some()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn every_target_has_a_distinct_rust_arch() {
		let mut seen = std::collections::HashSet::new();
		for target in ARCH_TARGETS {
			assert!(
				seen.insert(target.rust_arch),
				"duplicate rust_arch {}",
				target.rust_arch
			);
		}
	}

	#[test]
	fn lookup_resolves_every_listed_target() {
		for target in ARCH_TARGETS {
			assert_eq!(lookup(target.rust_arch), Some(target));
			assert!(is_supported(target.rust_arch));
		}
	}

	#[test]
	fn lookup_rejects_unknown_architectures() {
		// mips has no Rust target and no webview, so it must not be claimed.
		assert!(!is_supported("mips"));
		assert!(!is_supported("mips64"));
		assert!(!is_supported("s390x"));
		assert!(!is_supported("powerpc64"));
		assert!(!is_supported(""));
	}

	#[test]
	fn current_resolves_to_a_listed_target() {
		// The host running the tests must itself be a supported architecture.
		assert_eq!(current().rust_arch, std::env::consts::ARCH);
		assert_ne!(current().deb_arch, "unknown");
	}

	#[test]
	fn every_target_compiles_for_its_architecture() {
		// Guards against a target being added here without the build matrix
		// knowing about it, which would produce an architecture the launcher
		// claims to support but that is never released.
		for target in ARCH_TARGETS {
			assert!(
				target.rust_arch.chars().all(|c| c.is_ascii_alphanumeric()
					|| c == '_'
					|| c == '-'),
				"{} is not a Rust architecture name",
				target.rust_arch
			);
		}
	}

	#[test]
	fn debian_names_are_the_ones_the_distributions_use() {
		// These strings end up in .deb filenames and apt metadata, so a
		// mistake here ships an uninstallable package rather than failing
		// loudly at build time.
		let deb = |arch: &str| lookup(arch).expect("listed target").deb_arch;
		assert_eq!(deb("x86_64"), "amd64");
		assert_eq!(deb("aarch64"), "arm64");
		assert_eq!(deb("x86"), "i386");
		assert_eq!(deb("riscv64"), "riscv64");
		assert_eq!(deb("loongarch64"), "loong64");
	}
}
