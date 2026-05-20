//! T21 — Extension seam "any milestone — dormant license-verify utility"
//! acceptance: assert nookdb-core's dependency tree contains NO network /
//! HTTP / TLS crate.
//!
//! ("Acceptance: ... a test asserting the utility has no import of any
//!  network/HTTP module.")
//!
//! Scoping note: we audit `cargo tree -p nookdb-core --edges normal,build`
//! — the closure of `nookdb-core`'s shipped dependencies (runtime plus
//! build-script edges) — rather than `cargo metadata`.
//!
//! Reason: `cargo metadata`'s `packages` array includes the declared
//! dev-dependencies of transitively-resolved crates (e.g. `syn`'s own
//! dev-deps list `reqwest` for testing), which would false-positive a
//! substring scan for `reqwest` even though those declarations are never
//! compiled into `nookdb-core`. `cargo tree --edges normal,build` walks
//! only the actually-resolved shipping closure of the target crate.
//!
//! `nookdb-napi` and `dev-dependencies` are deliberately excluded — the
//! seam invariant is about what the MIT-licensed core library ships, not
//! what the NAPI binding's host runtime or future test fixtures pull in.

use std::process::Command;

#[test]
fn nookdb_core_dep_tree_contains_no_network_crate() {
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "--package",
            "nookdb-core",
            "--edges",
            "normal,build",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree failed");

    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );

    let stdout = String::from_utf8_lossy(&output.stdout);

    let banned = [
        "reqwest",
        "hyper",
        "tokio-net",
        "ureq",
        "isahc",
        "surf",
        "rustls",
        "rustls-pemfile",
        "native-tls",
        "openssl",
        "trust-dns",
        "hickory-resolver",
        "async-h1",
    ];

    // `cargo tree --format {p}` prints one "<name> <version> [<path>]" per
    // line. Match the crate name as the first whitespace-delimited token of
    // any line so we don't trigger on a substring inside a feature/path.
    let crates_in_tree: Vec<&str> = stdout
        .lines()
        .filter_map(|line| line.trim_start_matches('(').split_whitespace().next())
        // Strip an optional trailing "(*)" cargo-tree dedup marker, though
        // `{p}` never emits it; defensive.
        .map(|tok| tok.trim_end_matches("(*)"))
        .collect();

    for banned_name in &banned {
        assert!(
            !crates_in_tree.iter().any(|c| c == banned_name),
            "nookdb-core dep tree must not contain network crate '{banned_name}'; \
             license-verify utility's no-network invariant violated.\n\
             Full tree:\n{stdout}",
        );
    }
}
