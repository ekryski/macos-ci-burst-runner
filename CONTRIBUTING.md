# Contributing

Contributions are welcome under the Apache-2.0 license.

Before submitting a change:

```bash
swift build -c release
./Tests/test-controller.sh
```

Keep examples generic. Do not commit owner names, repository names, usernames,
runner registrations, credentials, tokens, machine identifiers, personal paths,
or captured workflow logs. Changes to availability, drain ordering, disk admission,
package verification, or credential handling must include a regression test and a
brief security rationale.
