# Contributing to Ditfa CLI

Focused fixes, useful documentation and reproducible bug reports are welcome. For larger changes, open an issue first to agree on the problem and approach.

1. Create a branch from `main` and keep the change focused.
2. Read [AGENTS.md](AGENTS.md) and the [development guide](docs/contributing.md) for repository conventions and toolchain setup.
3. Add meaningful regression coverage when behavior changes, and run the checks relevant to your change.
4. Open a pull request explaining the problem, resulting behavior and validation. Required checks must pass before merging.

Documentation-only changes do not need a full Rust build locally. CI validates public documentation and runs the repository's existing code checks.

For questions, use [Discussions](https://github.com/ditfa-dev/ditfa-cli/discussions). Search existing issues before filing a new bug. Review logs and remove secrets and personal information before posting them.

Participation follows our [community code of conduct](https://github.com/ditfa-dev/.github/blob/main/CODE_OF_CONDUCT.md). Security vulnerabilities belong in [private reports](SECURITY.md).

Code contributions are made under this project's [Apache-2.0 license](LICENSE); preserve the attribution in [NOTICE](NOTICE).
