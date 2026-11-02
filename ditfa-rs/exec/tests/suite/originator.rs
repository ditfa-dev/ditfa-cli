#![cfg(not(target_os = "windows"))]
#![allow(clippy::unwrap_used)]

use core_test_support::responses;
use core_test_support::test_ditfa_exec::test_ditfa_exec;
use ditfa_login::default_client::DITFA_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR;
use wiremock::matchers::header;

/// Verify that when the server reports an error, `ditfa-exec` exits with a
/// non-zero status code so automation can detect failures.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_ditfa_exec_originator() -> anyhow::Result<()> {
    let test = test_ditfa_exec();

    let server = responses::start_mock_server().await;
    let body = responses::sse(vec![
        responses::ev_response_created("response_1"),
        responses::ev_assistant_message("response_1", "Hello, world!"),
        responses::ev_completed("response_1"),
    ]);
    responses::mount_sse_once_match(&server, header("Originator", "ditfa_exec"), body).await;

    test.cmd_with_server(&server)
        .env_remove(DITFA_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR)
        .arg("--skip-git-repo-check")
        .arg("tell me something")
        .assert()
        .code(0);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supports_originator_override() -> anyhow::Result<()> {
    let test = test_ditfa_exec();

    let server = responses::start_mock_server().await;
    let body = responses::sse(vec![
        responses::ev_response_created("response_1"),
        responses::ev_assistant_message("response_1", "Hello, world!"),
        responses::ev_completed("response_1"),
    ]);
    responses::mount_sse_once_match(&server, header("Originator", "ditfa_exec_override"), body)
        .await;

    test.cmd_with_server(&server)
        .env("DITFA_INTERNAL_ORIGINATOR_OVERRIDE", "ditfa_exec_override")
        .arg("--skip-git-repo-check")
        .arg("tell me something")
        .assert()
        .code(0);

    Ok(())
}
