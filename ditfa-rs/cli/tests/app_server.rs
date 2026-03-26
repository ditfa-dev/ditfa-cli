use std::path::Path;

use anyhow::Result;
use app_test_support::app_server_json_shutdown_event;
use predicates::str::contains;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

fn ditfa_command(ditfa_home: &Path) -> Result<assert_cmd::Command> {
    let mut cmd = assert_cmd::Command::new(ditfa_utils_cargo_bin::cargo_bin("codex")?);
    cmd.env("DITFA_HOME", ditfa_home);
    Ok(cmd)
}

#[test]
fn strict_config_rejects_unknown_config_fields_for_app_server() -> Result<()> {
    let ditfa_home = TempDir::new()?;
    std::fs::write(
        ditfa_home.path().join("config.toml"),
        r#"
foo = "bar"
"#,
    )?;

    let mut cmd = ditfa_command(ditfa_home.path())?;
    cmd.args(["app-server", "--strict-config", "--listen", "off"])
        .assert()
        .failure()
        .stderr(contains("unknown configuration field"));

    Ok(())
}

#[test]
fn app_server_emits_json_info_events() -> Result<()> {
    let ditfa_home = TempDir::new()?;
    let event = app_server_json_shutdown_event("codex", &["app-server"], ditfa_home.path())?;

    assert_eq!(
        event,
        json!({
            "level": "INFO",
            "fields": {
                "message": "processor task exited",
                "exit_reason": "last_connection_closed",
                "remaining_connection_count": 0,
                "shutdown_forced": false,
            },
            "target": "ditfa_app_server",
        })
    );

    Ok(())
}
