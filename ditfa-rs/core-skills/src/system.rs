pub(crate) use ditfa_skills::install_system_skills;
pub(crate) use ditfa_skills::system_cache_root_dir;

use ditfa_utils_absolute_path::AbsolutePathBuf;

pub(crate) fn uninstall_system_skills(ditfa_home: &AbsolutePathBuf) {
    let _ = std::fs::remove_dir_all(system_cache_root_dir(ditfa_home));
}
