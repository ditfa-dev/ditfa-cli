use std::path::PathBuf;

use ditfa_utils_absolute_path::AbsolutePathBuf;

/// Runtime paths needed by exec-server child processes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecServerRuntimePaths {
    /// Stable path to the Codex executable used to launch hidden helper modes.
    pub ditfa_self_exe: AbsolutePathBuf,
    /// Path to the Linux sandbox helper alias used when the platform sandbox
    /// needs to re-enter Codex by argv0.
    pub ditfa_linux_sandbox_exe: Option<AbsolutePathBuf>,
}

impl ExecServerRuntimePaths {
    pub fn from_optional_paths(
        ditfa_self_exe: Option<PathBuf>,
        ditfa_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        let ditfa_self_exe = ditfa_self_exe.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Codex executable path is not configured",
            )
        })?;
        Self::new(ditfa_self_exe, ditfa_linux_sandbox_exe)
    }

    pub fn new(
        ditfa_self_exe: PathBuf,
        ditfa_linux_sandbox_exe: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        Ok(Self {
            ditfa_self_exe: absolute_path(ditfa_self_exe)?,
            ditfa_linux_sandbox_exe: ditfa_linux_sandbox_exe.map(absolute_path).transpose()?,
        })
    }
}

fn absolute_path(path: PathBuf) -> std::io::Result<AbsolutePathBuf> {
    AbsolutePathBuf::from_absolute_path(path.as_path())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidInput, err))
}
