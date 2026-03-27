use anyhow::Result;
use predicates::str::contains;
use std::path::Path;
use tempfile::TempDir;

fn ditfa_command(ditfa_home: &Path) -> Result<assert_cmd::Command> {
    let mut cmd = assert_cmd::Command::new(ditfa_utils_cargo_bin::cargo_bin("codex")?);
    cmd.env("DITFA_HOME", ditfa_home);
    Ok(cmd)
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn update_does_not_start_interactive_prompt() -> Result<()> {
    let ditfa_home = TempDir::new()?;

    ditfa_command(ditfa_home.path())?
        .arg("update")
        .assert()
        .failure()
        .stderr(contains("`codex update` is not available in debug builds"));

    Ok(())
}
