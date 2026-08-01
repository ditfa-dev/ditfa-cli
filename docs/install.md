## Installing & building

### System requirements

| Requirement                 | Details                                                         |
| --------------------------- | --------------------------------------------------------------- |
| Operating systems           | macOS 12+, Ubuntu 20.04+/Debian 10+, or Windows 11 **via WSL2** |
| Git (optional, recommended) | 2.23+ for built-in PR helpers                                   |
| RAM                         | 4-GB minimum (8-GB recommended)                                 |

### Install a release

```bash
npm install -g ditfa
```

For VS Code, install the **Ditfa Code** extension:

```bash
code --install-extension ditfa.ditfa-code
```

### Build from source

```bash
# Clone the repository and navigate to the root of the Cargo workspace.
git clone https://github.com/Teamtem-dev/ditfa-code.git
cd ditfa-code/ditfa-rs

# Install the Rust toolchain, if necessary.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup component add rustfmt
rustup component add clippy
# Install helper tools used by the workspace justfile:
cargo install --locked just
# DotSlash fetches pinned development tools such as buildifier on first use.
cargo install --locked dotslash
# Install nextest for the `just test` helper.
cargo install --locked cargo-nextest

# Build Ditfa Code.
cargo build

# Launch the TUI with a sample prompt.
cargo run --bin ditfa -- "explain this codebase to me"

# After making changes, use the root justfile helpers (they default to ditfa-rs):
just fmt
just fix -p <crate-you-touched>

# Run the relevant tests (project-specific is fastest), for example:
just test -p ditfa-tui
# `just test` runs the test suite via nextest:
just test
# Avoid `--all-features` for routine local runs because it increases build
# time and `target/` disk usage by compiling additional feature combinations.
```

Building the whole workspace needs a substantial amount of free disk space. To
build only the CLI binary:

```bash
cargo build --release --manifest-path ditfa-rs/Cargo.toml --bin ditfa
```

## Tracing / verbose logging

Ditfa Code is written in Rust, so it honors the `RUST_LOG` environment variable to configure its logging behavior.

The TUI records diagnostics in bounded local stores by default. Set `log_dir` explicitly to enable a plaintext TUI log for a run:

```bash
ditfa -c log_dir=./.ditfa-log
tail -F ./.ditfa-log/ditfa-tui.log
```

The non-interactive mode (`ditfa exec`) defaults to `RUST_LOG=error`, but messages are printed inline, so there is no need to monitor a separate file.

See the Rust documentation on [`RUST_LOG`](https://docs.rs/env_logger/latest/env_logger/#enabling-logging) for more information on the configuration options.
