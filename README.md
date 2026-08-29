# Mac CI Burst Runner

An opt-in menu-bar controller for using a Mac as a GitHub Actions self-hosted
runner only when you choose. It works with Apple Silicon and Intel Macs, and with
organization-scoped or repository-scoped runners.

The controller has four operator states:

- **Off:** the runner service is stopped and its unique scheduling label is absent.
- **Available:** the scheduling label is present, the service is online, and the
  Mac is held awake while connected to power.
- **Busy:** GitHub reports an active job. Turning Off is refused.
- **Draining:** eligibility is removed immediately; the current job may finish,
  then the service and sleep assertion stop.

It also enforces a configurable free-disk floor before availability and again in
a GitHub Actions job-start hook.

## Security first

A self-hosted runner executes repository-controlled code on your Mac. Use a
dedicated macOS account or dedicated machine whenever possible. Do not expose a
personal workstation to untrusted repositories, public-fork pull requests, or
workflows that can be modified by untrusted contributors.

For organization runners, create a runner group restricted to selected private
repositories and, where available, selected trusted workflows. Every eligible
workflow must require the configured `BURST_LABEL`; otherwise removing that label
cannot drain the machine safely.

The project stores no GitHub credential. It uses an existing `gh` login backed by
the macOS keychain. Never put tokens in `config.env`.

## Requirements

- macOS 13 or newer;
- Xcode Command Line Tools with Swift 6 support;
- [GitHub CLI](https://cli.github.com/) and `jq`;
- owner/admin permission to register and label the chosen runner scope.

For organization label management, the authenticated identity needs write access
to self-hosted runners. GitHub documents classic-token `admin:org` requirements
and fine-grained alternatives in its
[self-hosted runner REST API](https://docs.github.com/en/rest/actions/self-hosted-runners).

## Setup

1. Authenticate without copying a token into this repository:

   ```bash
   gh auth login
   gh auth status
   ```

2. Build and install the menu controller:

   ```bash
   ./Scripts/install-controller.sh
   ```

   This installs local files under `~/Library/Application Support/MacCIBurst`,
   creates a login LaunchAgent for the menu app, and creates—but does not load—the
   `caffeinate` LaunchAgent used while Available.

3. Edit the generated private configuration:

   ```bash
   open -e "$HOME/Library/Application Support/MacCIBurst/config.env"
   ```

   Set the scope, owner, runner name, unique burst label, runner directory, disk
   threshold, and optional runner group. No repository names are required for an
   organization runner unless you want current-job links in the menu.

4. In GitHub, restrict the organization runner group to selected trusted private
   repositories. GitHub recommends private repositories for self-hosted runners
   because public forks can otherwise submit dangerous workflow code. See
   [Managing access with runner groups](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access).

5. Audit every intended workflow. It must require the exact burst label:

   ```yaml
   jobs:
     test-on-mac:
       runs-on: [self-hosted, macOS, burst]
       steps:
         - uses: actions/checkout@v4
         - run: ./your-safe-test-command
   ```

   With an organization runner group, GitHub also supports group plus label
   routing:

   ```yaml
   runs-on:
     group: your-restricted-runner-group
     labels: burst
   ```

6. Register the runner:

   ```bash
   "$HOME/Library/Application Support/MacCIBurst/bin/setup-runner.sh"
   ```

   The official runner archive is selected for the current Mac architecture and
   installed only after SHA-256 verification. Registration finishes **Off** with
   the scheduling label removed.

7. Verify the safe initial state:

   ```bash
   "$HOME/Library/Application Support/MacCIBurst/bin/mac-ci-burst" status | jq
   ```

8. Exercise Available → Busy → Pause After Current Job → Off with a harmless
   workflow before relying on it for real work.

Closing a MacBook lid normally suspends it even when `caffeinate` is active. Keep
the lid open, or use a supported powered clamshell configuration.

## Command-line control

```bash
mac-ci-burst status       # JSON status for scripts or diagnostics
mac-ci-burst available    # pass disk gate, add eligibility, start runner
mac-ci-burst drain        # remove eligibility, finish current job, stop
mac-ci-burst off          # stop now; refuses while GitHub says busy
mac-ci-burst reconcile    # enforce desired state and disk floor
```

The installed command lives in
`~/Library/Application Support/MacCIBurst/bin/mac-ci-burst` unless
`MAC_CI_BURST_HOME` is overridden.

## Safety model

The unique burst label is the scheduling switch. Availability adds it while the
runner is offline, then starts the service. Drain removes it before doing anything
else, so no new matching job can be leased while an existing job finishes.

This is defense in depth, not sandboxing. A workflow already leased to the runner
can execute with the permissions of the macOS runner account. Disk checks do not
protect credentials, source files, or unrelated processes.

## Testing

```bash
swift build -c release
./Tests/test-controller.sh
```

The controller test uses mock GitHub, service, sleep, and disk commands. It never
registers a real runner or changes GitHub state.

## AI-assisted setup

[AI_AGENT_SETUP_PROMPT.md](AI_AGENT_SETUP_PROMPT.md) contains a ready-to-paste,
safety-bounded prompt for an AI coding agent. It tells the agent what it may inspect
and install, what decisions require the operator, and how to prove the runner is
Off before completing setup.

## License

Apache License 2.0. See [LICENSE](LICENSE).
