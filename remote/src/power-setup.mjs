import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { POWER_LABEL, POWER_ROOT } from "./power.mjs";
import { powerHelperSource } from "./power-helper.mjs";
import { check } from "./config.mjs";

const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
export function powerInstallScript(binary, uid) {
  check(Number.isSafeInteger(uid) && uid > 0, "power_setup", "ログイン中のユーザーで実行してください。");
  const plist = `/Library/LaunchDaemons/${POWER_LABEL}.plist`;
  return `set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
root=${quote(POWER_ROOT)}
plist=${quote(plist)}
if [ -L "$root" ] || [ -L "$plist" ]; then exit 1; fi
if [ -e "$root" ]; then
  [ -d "$root" ] && [ "$(stat -f '%u:%Lp' "$root")" = "0:755" ]
  [ ! -L "$root/owner" ] && [ "$(cat "$root/owner")" = ${quote(uid)} ]
fi
mkdir -p "$root"
chown root:wheel "$root"
chmod 755 "$root"
if ! mkdir "$root/.install-lock" 2>/dev/null; then exit 1; fi
trap 'result=$?; if [ "$result" -ne 0 ] && ! launchctl print system/${POWER_LABEL} >/dev/null 2>&1; then if [ -f "$plist" ]; then launchctl bootstrap system "$plist" 2>/dev/null || "$root/helper" --restore || true; fi; fi; rmdir "$root/.install-lock"; exit "$result"' EXIT
if [ -e "$root/requests" ]; then
  [ -d "$root/requests" ] && [ ! -L "$root/requests" ]
else
  mkdir "$root/requests"
fi
chown ${uid} "$root/requests"
chmod 700 "$root/requests"
printf '%s\\n' ${quote(uid)} > "$root/owner.new"
chmod 644 "$root/owner.new"
mv -f "$root/owner.new" "$root/owner"
install -o root -g wheel -m 755 ${quote(binary)} "$root/helper.new"
if launchctl print system/${POWER_LABEL} >/dev/null 2>&1; then
  launchctl bootout system/${POWER_LABEL}
fi
mv -f "$root/helper.new" "$root/helper"
# The new helper reconciles the saved choice and recovery journal at startup.
# Do not momentarily re-enable clamshell sleep during a helper upgrade.
cat > "$plist" <<'HATI_POWER_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${POWER_LABEL}</string>
<key>ProgramArguments</key><array><string>${POWER_ROOT}/helper</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>2</integer><key>ExitTimeOut</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>
HATI_POWER_PLIST
chown root:wheel "$plist"
chmod 644 "$plist"
launchctl bootstrap system "$plist"
`;
}

export async function powerSetup(action) {
  check(process.platform === "darwin", "power_unsupported", "この操作はMacで実行してください。");
  check(["install", "uninstall"].includes(action), "power_setup", "hati power install / uninstall を指定してください。");
  const uid = process.getuid();
  check(uid > 0, "power_setup", "sudoを付けずに実行してください。必要な処理だけで管理者認証を求めます。");
  if (action === "uninstall") {
    // Restore before removal; on failure retain the helper and recovery record.
    const result = spawnSync("/usr/bin/sudo", ["/bin/sh", "-c", `set -eu
root=${quote(POWER_ROOT)}
[ ! -L "$root" ] && [ "$(/usr/bin/stat -f '%u:%Lp' "$root")" = '0:755' ]
[ "$(/bin/cat "$root/owner")" = ${quote(uid)} ]
if /bin/launchctl print system/${POWER_LABEL} >/dev/null 2>&1; then
  /bin/launchctl bootout system/${POWER_LABEL}
fi
if ! "$root/helper" --restore; then
  /bin/launchctl bootstrap system ${quote(`/Library/LaunchDaemons/${POWER_LABEL}.plist`)} || true
  exit 1
fi
/bin/rm -f ${quote(`/Library/LaunchDaemons/${POWER_LABEL}.plist`)}
/bin/rm -rf "$root"
`], { stdio: "inherit" });
    check(result.status === 0, "power_setup", "電源制御の削除を完了できませんでした。復元情報は保持しています。");
    console.log("電源制御を削除し、元のスリープ設定に戻しました。");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "hati-power-build-"));
  try {
    const source = join(directory, "PowerHelper.swift"), binary = join(directory, "helper");
    writeFileSync(source, powerHelperSource);
    console.log("Macの電源制御を準備しています（Xcode Command Line Toolsが必要です）。");
    execFileSync("/usr/bin/xcrun", ["swiftc", "-O", source, "-o", binary], { stdio: "inherit" });
    console.log("管理者認証で電源制御をインストールします。スリープ防止はアプリの設定から有効にしてください。");
    const result = spawnSync("/usr/bin/sudo", ["/bin/sh", "-c", powerInstallScript(binary, uid)], { stdio: "inherit" });
    check(result.status === 0, "power_setup", "電源制御をインストールできませんでした。");
    console.log("準備できました。設定の「電源接続中は蓋を閉じても開発を続ける」をオンにしてください。");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
