#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
app_support="${MAC_CI_BURST_HOME:-$HOME/Library/Application Support/MacCIBurst}"
bin_dir="$app_support/bin"
config_file="$app_support/config.env"
launch_agents="$HOME/Library/LaunchAgents"
menu_label="dev.mac-ci-burst.menu"
awake_label="dev.mac-ci-burst.caffeinate"

[[ "$(uname -s)" == Darwin ]] || { print -u2 "This controller requires macOS"; exit 69; }
for tool in swift gh jq; do
  command -v "$tool" >/dev/null || { print -u2 "Missing required tool: $tool"; exit 69; }
done

(cd "$project_root" && swift build -c release)
mkdir -p "$bin_dir" "$launch_agents"
/usr/bin/install -m 755 "$project_root/.build/release/MacCIBurst" "$bin_dir/MacCIBurst"
/usr/bin/install -m 755 "$project_root/Scripts/mac-ci-burst" "$bin_dir/mac-ci-burst"
/usr/bin/install -m 755 "$project_root/Scripts/pre-job-disk-guard.sh" "$bin_dir/pre-job-disk-guard.sh"
/usr/bin/install -m 755 "$project_root/Scripts/setup-runner.sh" "$bin_dir/setup-runner.sh"

if [[ ! -f "$config_file" ]]; then
  /usr/bin/install -m 600 "$project_root/Scripts/config.env.example" "$config_file"
  print "Created $config_file"
fi

menu_plist="$launch_agents/$menu_label.plist"
awake_plist="$launch_agents/$awake_label.plist"

print -r -- "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
<key>Label</key><string>$menu_label</string>
<key>ProgramArguments</key><array><string>$bin_dir/MacCIBurst</string></array>
<key>EnvironmentVariables</key><dict><key>MAC_CI_BURST_CTL</key><string>$bin_dir/mac-ci-burst</string></dict>
<key>RunAtLoad</key><true/>
</dict></plist>" > "$menu_plist"

print -r -- "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
<key>Label</key><string>$awake_label</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>-s</string></array>
<key>ProcessType</key><string>Background</string>
</dict></plist>" > "$awake_plist"

plutil -lint "$menu_plist" "$awake_plist" >/dev/null
# bootout returns before launchd has finished tearing the job down, and
# bootstrapping into that window fails with "Input/output error" (5). Wait for
# the old job to disappear before bootstrapping the new one.
launchctl bootout "gui/$(id -u)/$menu_label" >/dev/null 2>&1 || true
for _ in {1..50}; do
  launchctl print "gui/$(id -u)/$menu_label" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$menu_plist"

# Application Support is on nobody's PATH, so the documented `mac-ci-burst`
# invocation fails without a link the user can actually reach.
link_dir=""
for candidate in "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in
    *":$candidate:"*) true ;;
    *) continue ;;
  esac
  [[ -d "$candidate" && -w "$candidate" ]] || continue
  link_dir="$candidate"
  break
done
if [[ -z "$link_dir" ]]; then
  print "Add the controller to your PATH:"
  print "  export PATH=\"\$PATH:$bin_dir\""
elif [[ -e "$link_dir/mac-ci-burst" && ! -L "$link_dir/mac-ci-burst" ]]; then
  print "Left the existing file $link_dir/mac-ci-burst alone; invoke the controller by full path."
else
  ln -sfn "$bin_dir/mac-ci-burst" "$link_dir/mac-ci-burst"
  print "Linked mac-ci-burst into $link_dir"
fi

print "Controller installed. Review config.env, then run:"
print "  $bin_dir/setup-runner.sh"
print "Registration leaves the runner Off and unschedulable."
