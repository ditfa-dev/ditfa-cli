/// Returns whether `host` is one of the ChatGPT hosts Ditfa is allowed to treat
/// as first-party ChatGPT HTTP traffic.
pub fn is_allowed_chatgpt_host(host: &str) -> bool {
    const EXACT_HOSTS: &[&str] = &["localhost", "chat.openai.com", "localhost:3000"];
    const SUBDOMAIN_SUFFIXES: &[&str] = &[".localhost", ".localhost:3000"];

    EXACT_HOSTS.contains(&host)
        || SUBDOMAIN_SUFFIXES
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_chatgpt_hosts_without_suffix_tricks() {
        for host in [
            "localhost",
            "foo.localhost",
            "staging.localhost",
            "chat.openai.com",
            "localhost:3000",
            "api.localhost:3000",
        ] {
            assert!(is_allowed_chatgpt_host(host));
        }

        for host in [
            "evilexample.com",
            "localhost.evil.example",
            "api.openai.com",
            "foo.chat.openai.com",
        ] {
            assert!(!is_allowed_chatgpt_host(host));
        }
    }
}
