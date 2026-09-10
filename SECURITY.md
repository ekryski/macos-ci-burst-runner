# Security policy

## Threat model

A GitHub Actions self-hosted runner executes workflow code with the permissions of
its macOS account. The menu toggle controls scheduling; it is not a sandbox and
does not make untrusted workflow code safe.

Use this project only with repositories and workflows you trust. Prefer a dedicated
macOS account or machine. Restrict organization runner groups to selected private
repositories and selected workflows where GitHub supports that policy.

## Credential handling

- Authenticate with `gh`; do not store tokens in this repository or `config.env`.
- Treat the runner work directory, diagnostic output, and workflow logs as
  potentially sensitive.
- Do not forward raw runner logs to an unauthenticated dashboard.
- Review third-party actions and pin them according to your organization's policy.

## Scheduling invariant

Every eligible workflow must require at least one entry from `BURST_LABELS`.
Drain removes every one of those labels before waiting for an active job.

The labels that remain on the runner while it is Off — `RUNNER_LABELS`, less any
`BURST_LABELS` entries it also lists — are what the Mac still matches on. If any workflow can be
satisfied by that remainder alone, the invariant is broken and draining cannot
make the machine unschedulable. Drain and Off therefore reduce the runner to that
remainder rather than removing only the configured capabilities, so a renamed or
hand-added label cannot survive as an unmanaged way to match the machine. Keep the
remainder to identity labels such as `self-hosted`, `macOS`, and the
architecture, and declare every selectable capability
(architecture, chip, memory) in `BURST_LABELS`.

## Reporting vulnerabilities

Do not open a public issue containing credentials, owner names, repository names,
runner names, filesystem paths, workflow logs, or other identifying data. Send a
minimal reproducer with secrets and identifying values removed through the
repository owner's private security-reporting channel.
