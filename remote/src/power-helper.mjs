// Compiled during the opt-in Mac setup. The installed LaunchDaemon runs only
// this root-owned binary, never Node, a user's checkout, or a user shell.
export const powerHelperSource = String.raw`
import Foundation
import IOKit.ps
import IOKit.pwr_mgt
import Darwin

let root = "/Library/Application Support/hati-power"
let fm = FileManager.default

enum PowerError: Error, CustomStringConvertible {
  case failure(String)
  var description: String { switch self { case .failure(let text): return text } }
}

// Keep the restoration record until the original value has been verified.
// A launchd restart (including after SIGKILL/reboot) resumes this recovery.
final class SleepPolicy {
  var read: () throws -> Bool
  var write: (Bool) throws -> Void
  var journal: () throws -> Bool?
  var save: (Bool) throws -> Void
  var clear: () throws -> Void
  init(read: @escaping () throws -> Bool, write: @escaping (Bool) throws -> Void,
       journal: @escaping () throws -> Bool?, save: @escaping (Bool) throws -> Void,
       clear: @escaping () throws -> Void) {
    self.read = read; self.write = write; self.journal = journal; self.save = save; self.clear = clear
  }
  func update(onAC: Bool?, requested: Bool) throws -> Bool {
    let previous = try journal()
    if onAC != true || !requested {
      if let previous {
        if try read() != previous { try write(previous) }
        guard try read() == previous else { throw PowerError.failure("元のスリープ設定に戻せませんでした。") }
        try clear()
      }
      return false
    }
    if previous == nil {
      guard try !read() else { throw PowerError.failure("別の設定でスリープが無効です。その設定を解除してから有効にしてください。") }
      try save(false) // durable write BEFORE the system-wide change
    }
    if try !read() { try write(true) }
    guard try read() else { throw PowerError.failure("スリープ防止を適用できませんでした。") }
    return true
  }
}

func validLease(_ expiry: Double, now: Double) -> Bool {
  expiry.isFinite && expiry > now && expiry <= now + 20
}

@Sendable func leaseIsValid(path: String, owner: UInt32, now: Double) -> Bool {
  let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  var st = stat()
  guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_uid == owner, st.st_size > 0, st.st_size <= 128 else { return false }
  var buffer = [UInt8](repeating: 0, count: 129)
  let count = read(fd, &buffer, buffer.count)
  guard count > 0, count <= 128,
        let json = try? JSONSerialization.jsonObject(with: Data(buffer.prefix(count))) as? [String: Double],
        let expiry = json["expiresAt"] else { return false }
  return validLease(expiry, now: now)
}

// Only the logged-in owner can publish a durable choice. A missing preference
// permits migration from an old daemon; malformed input never enables power.
struct PowerPreference: Decodable {
  let version: Int
  let serverId: UUID
  let revision: Int
  let enabled: Bool
}
func persistentChoice(path: String, owner: UInt32) throws -> Bool? {
  let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  if fd < 0 && errno == ENOENT { return nil }
  guard fd >= 0 else { throw PowerError.failure("電源設定を安全に読み取れません。") }
  defer { close(fd) }
  var st = stat()
  guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_uid == owner,
        st.st_mode & 0o077 == 0, st.st_nlink == 1, st.st_size > 0, st.st_size <= 512 else {
    throw PowerError.failure("電源設定の所有者・形式・権限を確認してください。")
  }
  var bytes = [UInt8](repeating: 0, count: 513)
  let count = read(fd, &bytes, bytes.count)
  guard count > 0, count <= 512 else { throw PowerError.failure("電源設定が不正です。") }
  let value = try JSONDecoder().decode(PowerPreference.self, from: Data(bytes.prefix(count)))
  guard value.version == 2, value.revision >= 0 else { throw PowerError.failure("電源設定の版が不正です。") }
  return value.enabled
}

// No root access or OS mutations. Used by the repository's native tests.
if CommandLine.arguments.contains("--self-test") {
  var value = false, saved: Bool?, writes: [Bool] = [], failRestore = false
  let policy = SleepPolicy(read: { value }, write: {
    if !$0 && failRestore { throw PowerError.failure("fixture") }
    value = $0; writes.append($0)
  }, journal: { saved }, save: { saved = $0 }, clear: { saved = nil })
  func expect(_ condition: @autoclosure () throws -> Bool) rethrows { let result = try condition(); precondition(result) }
  try expect(!policy.update(onAC: true, requested: false))
  try expect(!policy.update(onAC: false, requested: true))
  try expect(policy.update(onAC: true, requested: true))
  precondition(saved == false && writes == [true])
  try expect(policy.update(onAC: true, requested: true))
  precondition(writes == [true])
  failRestore = true
  do { _ = try policy.update(onAC: false, requested: true); fatalError("restore should fail") } catch {}
  precondition(saved == false && value)
  failRestore = false
  try expect(!policy.update(onAC: nil, requested: true))
  precondition(saved == nil && !value)
  _ = try policy.update(onAC: true, requested: true)
  _ = try policy.update(onAC: true, requested: false)
  precondition(saved == nil && !value)
  // Simulate a crash between journal creation and apply, and after apply.
  for current in [false, true] {
    saved = false; value = current
    _ = try policy.update(onAC: nil, requested: false)
    precondition(saved == nil && !value)
  }
  value = true
  do { _ = try policy.update(onAC: true, requested: true); fatalError("must not take another app's setting") } catch {}
  _ = try policy.update(onAC: false, requested: false)
  precondition(value && saved == nil)
  precondition(validLease(115, now: 100) && !validLease(100, now: 100) && !validLease(121, now: 100) && !validLease(.nan, now: 100))
  // Exercise the actual filesystem boundary using only temporary user files.
  let directory = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try fm.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? fm.removeItem(at: directory) }
  let file = directory.appendingPathComponent("lease.json").path
  try atomicJSON(["expiresAt": 115], path: file, durable: true)
  precondition(leaseIsValid(path: file, owner: getuid(), now: 100))
  precondition(!leaseIsValid(path: file, owner: getuid() + 1, now: 100))
  precondition(!leaseIsValid(path: file, owner: getuid(), now: 115))
  let choice = directory.appendingPathComponent("preference.json").path
  try atomicJSON(["version": 2, "serverId": UUID().uuidString, "revision": 1, "enabled": true], path: choice, durable: true)
  chmod(choice, 0o600)
  try expect(persistentChoice(path: choice, owner: getuid()) == true)
  // There is deliberately no clock or daemon PID in the persisted preference.
  do { _ = try persistentChoice(path: choice, owner: getuid() + 1); fatalError("wrong owner") } catch {}
  chmod(choice, 0o644)
  do { _ = try persistentChoice(path: choice, owner: getuid()); fatalError("unsafe mode") } catch {}
  chmod(choice, 0o600)
  try atomicJSON(["version": 2, "serverId": UUID().uuidString, "revision": 2, "enabled": false], path: choice, durable: true)
  chmod(choice, 0o600)
  try expect(persistentChoice(path: choice, owner: getuid()) == false)
  let link = directory.appendingPathComponent("link.json").path
  precondition(symlink(file, link) == 0)
  precondition(!leaseIsValid(path: link, owner: getuid(), now: 100))
  let pipe = directory.appendingPathComponent("pipe.json").path
  precondition(mkfifo(pipe, 0o600) == 0)
  precondition(!leaseIsValid(path: pipe, owner: getuid(), now: 100))
  try Data(repeating: 32, count: 129).write(to: URL(fileURLWithPath: file))
  precondition(!leaseIsValid(path: file, owner: getuid(), now: 100))
  try fm.removeItem(at: directory)
  print("power helper policy: passed")
  exit(0)
}

guard getuid() == 0 else { fputs("hati power helper requires root\n", stderr); exit(1) }
umask(0o022)

func pmset(_ args: [String]) throws -> String {
  let process = Process(), pipe = Pipe()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
  process.arguments = args
  process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"]
  process.standardOutput = pipe; process.standardError = pipe
  try process.run()
  // Bound a malfunctioning pmset; never leave a recovery worker blocked forever.
  let timeout = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
  DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timeout)
  let output = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit(); timeout.cancel()
  guard process.terminationStatus == 0 else { throw PowerError.failure("macOSの電源設定を更新できませんでした。") }
  return String(decoding: output, as: UTF8.self)
}

@Sendable func atomicJSON(_ value: Any, path: String, durable: Bool = false) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  try data.write(to: URL(fileURLWithPath: path), options: .atomic)
  guard durable else { return }
  let fd = open(path, O_RDONLY | O_NOFOLLOW)
  guard fd >= 0 else { throw PowerError.failure("復元情報を保存できませんでした。") }
  defer { close(fd) }
  guard fsync(fd) == 0 else { throw PowerError.failure("復元情報を保存できませんでした。") }
  let directory = open((path as NSString).deletingLastPathComponent, O_RDONLY)
  guard directory >= 0 else { throw PowerError.failure("復元情報を保存できませんでした。") }
  defer { close(directory) }
  guard fsync(directory) == 0 else { throw PowerError.failure("復元情報を保存できませんでした。") }
}

let policy = SleepPolicy(read: {
  let output = try pmset(["-g"])
  guard output.contains("System-wide power settings:") else { throw PowerError.failure("macOSの電源設定を読み取れません。") }
  for line in output.split(separator: "\n") {
    let words = line.split(whereSeparator: { $0.isWhitespace })
    if words.first == "SleepDisabled" {
      guard words.count == 2, ["0", "1"].contains(words[1]) else { throw PowerError.failure("電源設定の形式が不正です。") }
      return words[1] == "1"
    }
  }
  return false
}, write: { _ = try pmset(["-a", "disablesleep", $0 ? "1" : "0"]) }, journal: {
  let path = root + "/restore.json"
  guard fm.fileExists(atPath: path) else { return nil }
  let data = try Data(contentsOf: URL(fileURLWithPath: path))
  guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Bool], let previous = json["previous"] else {
    throw PowerError.failure("スリープ設定の復元情報を読み取れません。")
  }
  return previous
}, save: { try atomicJSON(["previous": $0], path: root + "/restore.json", durable: true) }, clear: {
  try fm.removeItem(atPath: root + "/restore.json")
})

@Sendable func restore() throws { _ = try policy.update(onAC: nil, requested: false) }
if CommandLine.arguments.contains("--restore") {
  do { try restore(); exit(0) } catch { fputs("\(error)\n", stderr); exit(1) }
}
guard let ownerText = try? String(contentsOfFile: root + "/owner", encoding: .utf8),
      let owner = UInt32(ownerText.trimmingCharacters(in: .whitespacesAndNewlines)), owner > 0 else { exit(1) }

@Sendable func onACPower() -> Bool? {
  guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
        let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return nil }
  return type as String == kIOPSACPowerValue
}

// The only user input is a short-lived timestamp. Open without following
// symlinks and reject pipes/devices/oversized files before reading as root.
@Sendable func hasLease(now: Double) -> Bool {
  let directory = root + "/requests"
  guard let names = try? fm.contentsOfDirectory(atPath: directory) else { return false }
  return names.prefix(1024).contains { name in
    guard name.hasSuffix(".json"), !name.contains("/") else { return false }
    return leaseIsValid(path: directory + "/" + name, owner: owner, now: now)
  }
}

var events: [[String: Any]] = (try? Data(contentsOf: URL(fileURLWithPath: root + "/events.json")))
  .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
@Sendable func record(_ kind: String) {
  events.append(["kind": kind, "at": Date().timeIntervalSince1970 * 1000])
  events = Array(events.suffix(40))
  try? atomicJSON(events, path: root + "/events.json", durable: true)
}
var lastState: String?
func tick(forceOff: Bool = false) {
  let now = Date().timeIntervalSince1970, ac = onACPower()
  var active = false, problem: String?
  do {
    let desired = try persistentChoice(path: root + "/requests/preference.json", owner: owner)
    active = try policy.update(onAC: ac, requested: !forceOff && (desired ?? hasLease(now: now)))
  } catch {
    problem = String(describing: error)
    do { try restore() } catch { problem = String(describing: error) }
  }
  let state = "\(ac.map(String.init) ?? "unknown"):\(active):\(problem != nil)"
  if state != lastState {
    record(problem != nil ? "power_error" : active ? "power_active" : ac == false ? "power_battery" : "power_inactive")
    lastState = state
  }
  try? atomicJSON(["version": 1, "owner": owner, "updatedAt": now,
                   "onAC": ac as Any? ?? NSNull(), "active": active,
                   "policyVersion": 2, "events": events,
                   "error": problem as Any? ?? NSNull()], path: root + "/status.json")
}

// Reconcile the durable choice directly; restart must not momentarily enable
// clamshell sleep while AC remains connected. Off/battery still restores first.
record("power_helper_started")
tick()
var notifier: io_object_t = 0
var port: IONotificationPortRef?
final class SystemPowerCallback {
  var connection: io_connect_t = 0
  let event: (UInt32) -> Void
  init(_ event: @escaping (UInt32) -> Void) { self.event = event }
}
let sleepCallback = Unmanaged.passRetained(SystemPowerCallback { message in
  if message == 0xe0000280 { record("system_sleep") }
  if message == 0xe0000300 { record("system_wake"); tick() }
})
sleepCallback.takeUnretainedValue().connection = IORegisterForSystemPower(sleepCallback.toOpaque(), &port, { context, _, message, argument in
  guard let context else { return }
  let callback = Unmanaged<SystemPowerCallback>.fromOpaque(context).takeUnretainedValue()
  callback.event(message)
  // IOMessage.h macros are not imported into Swift (iokit_common_msg).
  if message == 0xe0000270 || message == 0xe0000280 {
    IOAllowPowerChange(callback.connection, Int(bitPattern: argument))
  }
}, &notifier)
if let port, let source = IONotificationPortGetRunLoopSource(port)?.takeUnretainedValue() {
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
}
let timer = Timer(timeInterval: 1, repeats: true) { _ in tick() }
RunLoop.main.add(timer, forMode: .common)
final class PowerCallback {
  let run: () -> Void
  init(_ run: @escaping () -> Void) { self.run = run }
}
let callback = Unmanaged.passRetained(PowerCallback { tick() })
let source = IOPSNotificationCreateRunLoopSource({ context in
  guard let context else { return }
  Unmanaged<PowerCallback>.fromOpaque(context).takeUnretainedValue().run()
}, callback.toOpaque())?.takeRetainedValue()
if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
var signals: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
  signal(number, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
  source.setEventHandler { record("power_helper_stopped"); exit(0) }
  source.resume(); signals.append(source)
}
RunLoop.main.run()
`;
