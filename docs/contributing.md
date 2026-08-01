## Contributing

Ditfa Code is open source and contributions are welcome.

### Before you start

For anything beyond a small fix, open an issue first describing the problem and
the approach you have in mind. Agreeing on the shape of a change before it is
written saves everyone time.

The most valuable contributions come from people who understand a problem
domain deeply. Detailed bug reports, reproductions, and design discussion in
issues are often worth more than the patch itself — identifying the right
solution is usually the hard part.

### Development workflow

- Create a _topic branch_ from `main` — e.g. `feat/interactive-prompt`.
- Keep your changes focused. Unrelated fixes belong in separate PRs.
- Keep commits atomic: each commit should compile with tests passing.
- Ensure your change is free of lint warnings and test failures.

See [install.md](./install.md) for toolchain setup.

### Guidance for code contributions

1. **Start with an issue.** Open a new one or comment on an existing discussion
   so the solution can be agreed on before code is written.
2. **Add or update tests.** A bug fix should come with coverage that fails
   before your change and passes afterwards. 100% coverage is not required, but
   aim for meaningful assertions.
3. **Document behavior.** If your change affects user-facing behavior, update
   the README, the inline help (`ditfa --help`), or the relevant docs.

### Model metadata updates

When a change updates model catalogs or model metadata (`/models` payloads,
presets, or fixtures):

- Set `input_modalities` explicitly for any model that does not support images.
- Keep compatibility defaults in mind: omitted `input_modalities` currently
  implies text + image support.
- Ensure client surfaces that accept images (for example, TUI paste/attach)
  consume the same capability signal.
- Add/update tests that cover unsupported-image behavior and warning paths.

### Running checks

Use the root `just` helpers so you stay consistent with the rest of the
workspace:

```bash
just fmt                     # format everything
just fix -p <crate>          # clippy fixes for the crate you touched
just test -p ditfa-tui       # tests for one crate (fastest)
just test                    # full sweep via nextest
```

For the VS Code extension:

```bash
cd ditfa-vscode
pnpm install
pnpm run typecheck
pnpm test
```

CI failures that could have been caught locally slow the process down for
everyone, so run the relevant checks before pushing.

### Opening a pull request

- Describe **what** changed, **why**, and **how**.
- Link to the related issue.
- Make sure your branch is up to date with `main` and conflicts are resolved.
- Mark the PR as **Ready for review** only when you believe it is mergeable.

### Community values

- **Be kind and inclusive.** Treat others with respect; we follow the
  [Contributor Covenant](https://www.contributor-covenant.org/).
- **Assume good intent.** Written communication is hard — err on the side of
  generosity.
- **Teach & learn.** If you spot something confusing, open an issue or
  discussion with suggestions or clarifications.

### Getting help

If you run into problems setting up the project, would like feedback on an
idea, or just want to say _hi_ — please open a Discussion topic or jump into
the relevant issue.

### Security

Found a vulnerability? Please follow the process in
[SECURITY.md](../SECURITY.md) rather than opening a public issue.

### Attribution

Ditfa Code is derived from [openai/ditfa](https://github.com/openai/codex),
licensed under Apache-2.0. Contributions here are made under the same license.
See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
