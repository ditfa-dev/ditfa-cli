use super::*;

pub(super) fn environment_selection_error(err: DitfaErr) -> JSONRPCErrorError {
    match err {
        DitfaErr::InvalidRequest(message) => invalid_request(message),
        err => internal_error(format!("failed to validate environment selections: {err}")),
    }
}
