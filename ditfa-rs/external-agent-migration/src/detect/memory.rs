use crate::discover_external_memory_files;
use crate::memory_import::projects_needing_import;
use crate::memory_import::resources_root;
use crate::model::ExternalAgentConfigMigrationItem;
use crate::model::ExternalAgentConfigMigrationItemType;
use crate::model::MigrationDetails;
use std::io;
use std::path::Path;

pub(super) fn detect(
    ditfa_home: &Path,
    external_agent_home: &Path,
) -> io::Result<Option<ExternalAgentConfigMigrationItem>> {
    let memory_files = discover_external_memory_files(external_agent_home)?;
    let memory = projects_needing_import(ditfa_home, &memory_files)?;
    if memory.is_empty() {
        return Ok(None);
    }

    Ok(Some(ExternalAgentConfigMigrationItem {
        item_type: ExternalAgentConfigMigrationItemType::Memory,
        description: format!(
            "Import memory files from {} to {}",
            external_agent_home.join("projects").display(),
            resources_root(ditfa_home).display()
        ),
        cwd: None,
        details: Some(MigrationDetails {
            memory: memory.into_iter().collect(),
            ..Default::default()
        }),
    }))
}
