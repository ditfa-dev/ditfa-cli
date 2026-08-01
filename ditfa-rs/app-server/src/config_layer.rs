use ditfa_app_server_protocol::ConfigLayer as ApiConfigLayer;
use ditfa_app_server_protocol::ConfigLayerMetadata as ApiConfigLayerMetadata;
use ditfa_app_server_protocol::ConfigLayerSource as ApiConfigLayerSource;
use ditfa_config::ConfigLayer;
use ditfa_config::ConfigLayerMetadata;
use ditfa_config::ConfigLayerSource;

/// Converts a config-layer source owned by `ditfa-config` into the app-server wire type owned by
/// `ditfa-app-server-protocol`.
///
/// The types stay separate so app-server protocol ownership does not leak into the config domain
/// crate. Because this crate owns neither type, Rust's orphan rules require an explicit conversion
/// function instead of a `From` implementation.
pub(crate) fn config_layer_source_to_api(source: ConfigLayerSource) -> ApiConfigLayerSource {
    match source {
        ConfigLayerSource::Mdm { domain, key } => ApiConfigLayerSource::Mdm { domain, key },
        ConfigLayerSource::System { file } => ApiConfigLayerSource::System { file },
        ConfigLayerSource::EnterpriseManaged { id, name } => {
            ApiConfigLayerSource::EnterpriseManaged { id, name }
        }
        ConfigLayerSource::User { file, profile } => ApiConfigLayerSource::User { file, profile },
        ConfigLayerSource::Project { dot_ditfa_folder } => {
            ApiConfigLayerSource::Project { dot_ditfa_folder }
        }
        ConfigLayerSource::SessionFlags => ApiConfigLayerSource::SessionFlags,
        ConfigLayerSource::LegacyManagedConfigTomlFromFile { file } => {
            ApiConfigLayerSource::LegacyManagedConfigTomlFromFile { file }
        }
        ConfigLayerSource::LegacyManagedConfigTomlFromMdm => {
            ApiConfigLayerSource::LegacyManagedConfigTomlFromMdm
        }
    }
}

/// Converts config-layer metadata owned by `ditfa-config` into the app-server wire type owned by
/// `ditfa-app-server-protocol`.
///
/// The types stay separate so app-server protocol ownership does not leak into the config domain
/// crate. Because this crate owns neither type, Rust's orphan rules require an explicit conversion
/// function instead of a `From` implementation.
pub(crate) fn config_layer_metadata_to_api(
    metadata: ConfigLayerMetadata,
) -> ApiConfigLayerMetadata {
    ApiConfigLayerMetadata {
        name: config_layer_source_to_api(metadata.name),
        version: metadata.version,
    }
}

/// Converts a config layer owned by `ditfa-config` into the app-server wire type owned by
/// `ditfa-app-server-protocol`.
///
/// The types stay separate so app-server protocol ownership does not leak into the config domain
/// crate. Because this crate owns neither type, Rust's orphan rules require an explicit conversion
/// function instead of a `From` implementation.
pub(crate) fn config_layer_to_api(layer: ConfigLayer) -> ApiConfigLayer {
    ApiConfigLayer {
        name: config_layer_source_to_api(layer.name),
        version: layer.version,
        config: layer.config,
        disabled_reason: layer.disabled_reason,
    }
}
