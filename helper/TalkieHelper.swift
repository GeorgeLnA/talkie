// Talkie's small Mac helper. Talkie starts it and talks to it with one JSON object per line.
// It never touches the network. Everything it does stays on this Mac:
//  - tells Talkie whether the talk keys are still held down (hold to talk)
//  - "jump back": press Command + Shift + Option together and let go to return to the previous app
//  - turns voice clips into text with Apple's on-device speech recognition (macOS 26)
//  - writes short chat summaries with Apple's on-device model, when Apple Intelligence is on
import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import Speech
#if canImport(FoundationModels)
import FoundationModels
#endif

let ownBundle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "com.leadandallure.talkie"
let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
  outLock.lock()
  out.write(d)
  out.write("\n".data(using: .utf8)!)
  outLock.unlock()
}

// ---------- keys ----------
func flags() -> CGEventFlags { CGEventSource.flagsState(.combinedSessionState) }
let modifierKeyCodes: Set<UInt16> = [0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F]
func anyOtherKeyDown() -> Bool {
  for k: UInt16 in 0...0x7E where !modifierKeyCodes.contains(k) {
    if CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(k)) { return true }
  }
  return false
}

final class Keys {
  var holdTimer: DispatchSourceTimer?
  var chordTimer: DispatchSourceTimer?
  var chordArmed = false
  var chordSpoiled = false
  var chordStart = Date()

  func mods() -> [String: Any] {
    let f = flags()
    return ["ev": "mods", "cmd": f.contains(.maskCommand), "shift": f.contains(.maskShift),
            "alt": f.contains(.maskAlternate), "ctrl": f.contains(.maskControl)]
  }

  // Reports once when Command or Shift (the talk keys) are let go.
  func watchHold(id: Any?) {
    holdTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(5))
    t.setEventHandler { [weak self] in
      let f = flags()
      if !f.contains(.maskCommand) || !f.contains(.maskShift) {
        emit(["ev": "hold-released", "id": id ?? NSNull()])
        self?.holdTimer?.cancel()
        self?.holdTimer = nil
      }
    }
    holdTimer = t
    t.resume()
  }
  func stopHold() { holdTimer?.cancel(); holdTimer = nil }

  func setJumpBack(_ on: Bool) {
    chordTimer?.cancel()
    chordTimer = nil
    guard on else { return }
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now(), repeating: .milliseconds(50), leeway: .milliseconds(15))
    t.setEventHandler { [weak self] in self?.chordTick() }
    chordTimer = t
    t.resume()
  }

  func chordTick() {
    let f = flags()
    let cmd = f.contains(.maskCommand), shift = f.contains(.maskShift), alt = f.contains(.maskAlternate)
    let ctrl = f.contains(.maskControl)
    if cmd && shift && alt && !ctrl {
      if !chordArmed { chordArmed = true; chordSpoiled = false; chordStart = Date() }
      if anyOtherKeyDown() { chordSpoiled = true } // it was a shortcut like Cmd+Shift+Option+K
    } else if chordArmed {
      if ctrl || anyOtherKeyDown() { chordSpoiled = true }
      if !cmd && !shift && !alt {
        let quick = Date().timeIntervalSince(chordStart) < 1.5
        if !chordSpoiled && quick { Apps.shared.jumpBack() }
        chordArmed = false
      }
    }
  }
}

// ---------- previous app ----------
final class Apps {
  static let shared = Apps()
  var recent: [pid_t] = []

  func start() {
    if let f = NSWorkspace.shared.frontmostApplication { note(f) }
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] n in
      if let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { self?.note(app) }
    }
  }
  func note(_ app: NSRunningApplication) {
    if app.bundleIdentifier == ownBundle || app.processIdentifier == getpid() { return }
    recent.removeAll { $0 == app.processIdentifier }
    recent.insert(app.processIdentifier, at: 0)
    if recent.count > 12 { recent.removeLast() }
  }
  func jumpBack() {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard let pid = recent.first(where: { $0 != front && NSRunningApplication(processIdentifier: $0) != nil }),
          let app = NSRunningApplication(processIdentifier: pid) else { return }
    if let url = app.bundleURL {
      let cfg = NSWorkspace.OpenConfiguration()
      cfg.activates = true
      NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in }
    } else {
      app.activate()
    }
    emit(["ev": "jumped", "to": app.bundleIdentifier ?? app.localizedName ?? "?"])
  }
}

// ---------- speech to text (on this Mac) ----------
func transcribe(id: Any, path: String, locale: String) {
  #if compiler(>=6.2)
  if #available(macOS 26, *) {
    Task {
      do {
        let url = URL(fileURLWithPath: path)
        var found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale))
        if found == nil { found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
        guard let loc = found else {
          emit(["ev": "transcript", "id": id, "error": "language not supported"]); return
        }
        let t = SpeechTranscriber(locale: loc, preset: .transcription)
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
          try await req.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [t])
        let file = try AVAudioFile(forReading: url)
        async let text: String = t.results.reduce("") { $0 + String($1.text.characters) }
        if let last = try await analyzer.analyzeSequence(from: file) {
          try await analyzer.finalizeAndFinish(through: last)
        } else {
          await analyzer.cancelAndFinishNow()
        }
        let s = try await text
        emit(["ev": "transcript", "id": id, "text": s.trimmingCharacters(in: .whitespacesAndNewlines)])
      } catch {
        emit(["ev": "transcript", "id": id, "error": String(describing: error)])
      }
    }
    return
  }
  #endif
  emit(["ev": "transcript", "id": id, "error": "needs macOS 26"])
}

// ---------- summaries (on this Mac) ----------
func aiStatus() -> String {
  #if compiler(>=6.2) && canImport(FoundationModels)
  if #available(macOS 26, *) {
    switch SystemLanguageModel.default.availability {
    case .available: return "available"
    case .unavailable(let r): return String(describing: r)
    }
  }
  #endif
  return "unsupported"
}

func summarize(id: Any, text: String) {
  #if compiler(>=6.2) && canImport(FoundationModels)
  if #available(macOS 26, *), case .available = SystemLanguageModel.default.availability {
    Task {
      do {
        let session = LanguageModelSession(instructions: """
          You summarise a team's short voice chat. Be brief and factual. Use only what was said.
          Write at most 8 lines. Start every line with exactly one of these labels:
          Decision: / Problem: / Solved: / To do: / Point:
          Each line is one short plain sentence. If nothing fits a label, leave that label out.
          """)
        let r = try await session.respond(to: "Chat transcript:\n" + String(text.suffix(12000)))
        emit(["ev": "summary", "id": id, "text": r.content])
      } catch {
        emit(["ev": "summary", "id": id, "error": String(describing: error)])
      }
    }
    return
  }
  #endif
  emit(["ev": "summary", "id": id, "error": "unavailable", "reason": aiStatus()])
}

// ---------- main ----------
let keys = Keys()
Apps.shared.start()
setvbuf(stdout, nil, _IOLBF, 0)
var caps: [String: Any] = ["ev": "ready", "ai": aiStatus(), "transcribe": false]
#if compiler(>=6.2)
if #available(macOS 26, *) { caps["transcribe"] = SpeechTranscriber.isAvailable }
#endif
emit(caps)

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine(strippingNewline: true) {
    guard let d = line.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let cmd = msg["cmd"] as? String else { continue }
    DispatchQueue.main.async {
      switch cmd {
      case "mods": var m = keys.mods(); m["id"] = msg["id"] ?? NSNull(); emit(m)
      case "watch-hold": keys.watchHold(id: msg["id"])
      case "stop-hold": keys.stopHold()
      case "jumpback": keys.setJumpBack((msg["on"] as? Bool) ?? false)
      case "jump-now": Apps.shared.jumpBack()
      case "front": emit(["ev": "front", "id": msg["id"] ?? NSNull(), "app": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""])
      case "transcribe":
        transcribe(id: msg["id"] ?? NSNull(), path: (msg["path"] as? String) ?? "", locale: (msg["locale"] as? String) ?? "en-US")
      case "summarize": summarize(id: msg["id"] ?? NSNull(), text: (msg["text"] as? String) ?? "")
      default: break
      }
    }
  }
  exit(0) // Talkie closed the pipe: it has quit, so the helper goes too
}
RunLoop.main.run()
