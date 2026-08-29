#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/mac-ci-burst-test.XXXXXX")"
trap '/bin/rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/home/Library/Application Support/MacCIBurst" \
  "$test_root/home/Library/LaunchAgents" "$test_root/runner"
export MOCK_STATE="$test_root/github.json"
export MOCK_SERVICE="$test_root/service-loaded"
export MOCK_CAFFEINATE="$test_root/caffeinate-loaded"
export MOCK_FREE_KIB=209715200

print -r -- '{"runners":[{"id":42,"name":"Test-Mac","os":"macOS","status":"offline","busy":false,"labels":[{"name":"self-hosted"},{"name":"macOS"}]}]}' > "$MOCK_STATE"

cat > "$test_root/bin/gh" <<'MOCK_GH'
#!/bin/zsh
set -euo pipefail
method=GET
path=""
while (( $# )); do
  case "$1" in
    --method|-X) method="$2"; shift 2 ;;
    --input) shift 2 ;;
    --paginate|api) shift ;;
    /*) path="$1"; shift ;;
    *) shift ;;
  esac
done
case "$path" in
  /orgs/test-owner/actions/runners|/repos/test-owner/test-repo/actions/runners) /bin/cat "$MOCK_STATE" ;;
  /orgs/test-owner/actions/runners/42/labels|/repos/test-owner/test-repo/actions/runners/42/labels)
    [[ "$method" == POST ]]
    label="$(/bin/cat | /usr/bin/jq -r '.labels[0]')"
    /usr/bin/jq --arg label "$label" '.runners[0].labels += [{name:$label}]' "$MOCK_STATE" > "$MOCK_STATE.tmp"
    /bin/mv "$MOCK_STATE.tmp" "$MOCK_STATE"
    /bin/cat "$MOCK_STATE"
    ;;
  /orgs/test-owner/actions/runners/42/labels/*|/repos/test-owner/test-repo/actions/runners/42/labels/*)
    [[ "$method" == DELETE ]]
    label="${path##*/}"
    /usr/bin/jq --arg label "$label" '.runners[0].labels |= map(select(.name != $label))' "$MOCK_STATE" > "$MOCK_STATE.tmp"
    /bin/mv "$MOCK_STATE.tmp" "$MOCK_STATE"
    /bin/cat "$MOCK_STATE"
    ;;
  *) print -u2 "unexpected mock gh path: $path"; exit 2 ;;
esac
MOCK_GH

cat > "$test_root/bin/df" <<'MOCK_DF'
#!/bin/zsh
print 'Filesystem 1024-blocks Used Available Capacity Mounted'
print "mock 500000000 100000000 $MOCK_FREE_KIB 33% /System/Volumes/Data"
MOCK_DF

cat > "$test_root/bin/launchctl" <<'MOCK_LAUNCHCTL'
#!/bin/zsh
set -euo pipefail
case "$1" in
  print) [[ "$2" == *dev.mac-ci-burst.caffeinate ]] && [[ -f "$MOCK_CAFFEINATE" ]] || [[ -f "$MOCK_SERVICE" ]] ;;
  bootstrap) /usr/bin/touch "$MOCK_CAFFEINATE" ;;
  bootout) /bin/rm -f "$MOCK_CAFFEINATE" ;;
  *) exit 2 ;;
esac
MOCK_LAUNCHCTL

cat > "$test_root/runner/svc.sh" <<'MOCK_SERVICE'
#!/bin/zsh
set -euo pipefail
case "$1" in
  start)
    /usr/bin/touch "$MOCK_SERVICE"
    /usr/bin/jq '.runners[0].status="online"' "$MOCK_STATE" > "$MOCK_STATE.tmp"
    /bin/mv "$MOCK_STATE.tmp" "$MOCK_STATE"
    ;;
  stop)
    /bin/rm -f "$MOCK_SERVICE"
    /usr/bin/jq '.runners[0].status="offline" | .runners[0].busy=false' "$MOCK_STATE" > "$MOCK_STATE.tmp"
    /bin/mv "$MOCK_STATE.tmp" "$MOCK_STATE"
    ;;
  *) exit 2 ;;
esac
MOCK_SERVICE

chmod +x "$test_root/bin/gh" "$test_root/bin/df" "$test_root/bin/launchctl" "$test_root/runner/svc.sh"
print 'actions.runner.test.Test-Mac' > "$test_root/runner/.service"
print '<plist version="1.0"><dict/></plist>' > "$test_root/home/Library/LaunchAgents/dev.mac-ci-burst.caffeinate.plist"

app_support="$test_root/home/Library/Application Support/MacCIBurst"
cat > "$app_support/config.env" <<CONFIG
GITHUB_SCOPE_TYPE=org
GITHUB_OWNER=test-owner
RUNNER_NAME=Test-Mac
BURST_LABEL=burst
RUNNER_DIR="$test_root/runner"
MIN_FREE_GIB=100
MONITORED_REPOSITORIES=
CONFIG
print off > "$app_support/desired-state"

export HOME="$test_root/home"
export PATH="$test_root/bin:/usr/bin:/bin"
export MAC_CI_BURST_HOME="$app_support"
ctl="$project_root/Scripts/mac-ci-burst"

[[ "$("$ctl" status | /usr/bin/jq -r '.state')" == off ]]
"$ctl" available
[[ "$("$ctl" status | /usr/bin/jq -r '.state')" == available ]]
[[ -f "$MOCK_SERVICE" && -f "$MOCK_CAFFEINATE" ]]

/usr/bin/jq '.runners[0].busy=true' "$MOCK_STATE" > "$MOCK_STATE.tmp" && /bin/mv "$MOCK_STATE.tmp" "$MOCK_STATE"
"$ctl" drain
[[ "$(<"$app_support/desired-state")" == drain ]]
[[ -f "$MOCK_SERVICE" ]]
! /usr/bin/jq -e '.runners[0].labels | any(.name == "burst")' "$MOCK_STATE" >/dev/null

set +e
"$ctl" off >/dev/null 2>&1
off_rc=$?
set -e
[[ "$off_rc" == 75 ]]

/usr/bin/jq '.runners[0].busy=false' "$MOCK_STATE" > "$MOCK_STATE.tmp" && /bin/mv "$MOCK_STATE.tmp" "$MOCK_STATE"
"$ctl" reconcile
[[ "$(<"$app_support/desired-state")" == off ]]
[[ ! -f "$MOCK_SERVICE" && ! -f "$MOCK_CAFFEINATE" ]]

export MOCK_FREE_KIB=52428800
set +e
"$ctl" available >/dev/null 2>&1
disk_rc=$?
set -e
[[ "$disk_rc" == 75 ]]

cat > "$app_support/config.env" <<CONFIG
GITHUB_SCOPE_TYPE=repo
GITHUB_OWNER=test-owner
GITHUB_REPOSITORY=test-repo
RUNNER_NAME=Test-Mac
BURST_LABEL=burst
RUNNER_DIR="$test_root/runner"
MIN_FREE_GIB=100
CONFIG
[[ "$("$ctl" status | /usr/bin/jq -r '.settingsURL')" == "https://github.com/test-owner/test-repo/settings/actions/runners" ]]

print 'controller transition, disk-gate, and scope tests passed'
