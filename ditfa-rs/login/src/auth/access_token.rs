const PERSONAL_ACCESS_TOKEN_PREFIX: &str = "at-";

pub(super) enum DitfaAccessToken<'a> {
    PersonalAccessToken(&'a str),
    AgentIdentityJwt(&'a str),
}

pub(super) fn classify_ditfa_access_token(access_token: &str) -> DitfaAccessToken<'_> {
    if access_token.starts_with(PERSONAL_ACCESS_TOKEN_PREFIX) {
        DitfaAccessToken::PersonalAccessToken(access_token)
    } else {
        DitfaAccessToken::AgentIdentityJwt(access_token)
    }
}

#[cfg(test)]
#[path = "access_token_tests.rs"]
mod tests;
