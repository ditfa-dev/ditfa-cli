/// Returns whether `host` is one of the ChatGPT hosts Ditfa is allowed to treat
/// as first-party ChatGPT HTTP traffic.
pub fn is_allowed_chatgpt_host(host: &str) -> bool {
    const EXACT_HOSTS: &[&str] = &["chat.ditfa.com", "chat.openai.com"];
    const SUBDOMAIN_SUFFIXES: &[&str] = &[".chat.ditfa.com"];

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
            "chat.ditfa.com",
            "foo.chat.ditfa.com",
            "chat.openai.com",
            "staging.chat.ditfa.com",
            "api.staging.chat.ditfa.com",
        ] {
            assert!(is_allowed_chatgpt_host(host));
        }

        for host in [
            "evilexample.com",
            "localhost",
            "foo.localhost",
            "evilchat.ditfa.com",
            "chat.ditfa.com.evil.example",
            "api.openai.com",
            "foo.chat.openai.com",
        ] {
            assert!(!is_allowed_chatgpt_host(host));
        }
    }
}
