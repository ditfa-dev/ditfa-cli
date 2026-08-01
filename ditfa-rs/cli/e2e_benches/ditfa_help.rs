#![allow(clippy::expect_used)]

use std::process::Command;

use divan::Bencher;

fn main() {
    divan::main();
}

/// Exercises the Bazel-backed end-to-end benchmark path with a cheap,
/// deterministic Ditfa invocation. Richer scenarios can add separate
/// benchmark binaries without making the shared harness depend on them.
#[divan::bench(sample_count = 20, sample_size = 1)]
fn ditfa_help(bencher: Bencher) {
    let ditfa = ditfa_utils_cargo_bin::cargo_bin("ditfa")
        .expect("ditfa binary should be available through Bazel runfiles");

    bencher.bench_local(move || {
        let output = Command::new(&ditfa)
            .arg("--help")
            .output()
            .expect("ditfa --help should run");
        assert!(output.status.success(), "ditfa --help should succeed");
    });
}
