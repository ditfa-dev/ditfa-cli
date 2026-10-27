# Security policy

## Report a vulnerability privately

Please do not post vulnerabilities, exploit details, API keys or personal information in public issues or discussions.

Use **Security → Report a vulnerability** in the affected repository:

- [Ditfa CLI private report](https://github.com/ditfa-dev/ditfa-cli/security/advisories/new)
- [Ditfa Desktop and release distribution private report](https://github.com/ditfa-dev/ditfa-releases/security/advisories/new)

If you cannot access private reporting or are unsure which repository is affected, use [Ditfa's contact page](https://ditfa.com/contact) to request a private reporting channel. Do not include exploit details in an initial general contact request.

Include the affected product and version, operating system, impact, minimal reproduction steps and any proposed mitigation. Redact credentials and unrelated private data. Test only accounts and systems you own or are explicitly authorized to assess.

## Supported versions

Security fixes target the latest stable release. Older versions and prereleases may not receive backported fixes. Upgrade before checking whether an issue persists.

## Coordinated disclosure

Maintainers review reports on a best-effort basis and coordinate next steps privately. Please allow time to investigate and prepare a fix before publishing details. This policy does not establish a paid bug bounty or guarantee a response or remediation deadline.

## Protect your environment

Download software from [ditfa.com/downloads](https://ditfa.com/downloads) or Ditfa's official GitHub releases. Keep API keys out of Git, screenshots and public logs. If a key is exposed, revoke it with its provider and replace it.

For the CLI, review generated changes and command approvals, use the narrowest practical execution permissions, and read [sandbox and approval guidance](https://github.com/ditfa-dev/ditfa-cli/blob/main/docs/sandbox.md). Model responses and downloaded content can contain unsafe instructions; sandboxing does not guarantee that all actions or model output are safe.
