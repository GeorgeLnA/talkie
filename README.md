# Talkie

Push-to-talk for your team. Hold a shortcut from any app, speak, let go: your voice comes out of your teammates' speakers. You never leave the tab you are on. If they are on Do Not Disturb, it waits for them as a message behind a green box in the top right corner of their screen, and they play it with one click.

- **Hold to talk:** hold `Cmd+Shift+Space` and speak; let go to send. It goes to whoever you talked to last.
- **Choose who:** tap `Cmd+Shift+Space` instead and a small list opens in the top right corner, under the clock. Arrow keys to choose, Space to add more people (a group), Enter to talk (press the shortcut again to send). Or keep the list open and hold the shortcut to talk to whoever is highlighted. Your app stays in front the whole time.
- **Chats and Do Not Disturb from the same list:** press `C` (or click **Chats**) to open your chats and messages, and `D` to turn Do Not Disturb on or off. The Chats button shows how many messages are new. You can also open Talkie from Applications or Spotlight, or from its menu bar icon.
- **Out of the way:** nothing shows on screen unless you are talking, someone is talking to you, or a message is waiting. No Dock icon; Talkie lives in the menu bar.
- **Do Not Disturb:** voice arrives as a message instead of playing out loud. A green box appears top right: **Play**, **Wait 5 min** (the sender is told), **Later**, or **Reply**.
- **Chats with text and summaries (Mac):** every conversation is kept as a chat. Speech is turned into text on your own Mac (macOS 26), and each chat gets short bullet points: decisions, problems, what solved them, to-dos. With Apple Intelligence switched on, the summaries are written by Apple's on-device model; otherwise Talkie picks out the key sentences itself. Nothing leaves your computer for this.
- **Jump back (Mac, optional):** press `Cmd+Shift+Option` together and let go to return to the app you were just in. Turn it on in Settings.
- **Soft sounds:** a small two-note blip when talking starts and ends, two gentle taps when a message arrives.
- **Light:** about 90 MB of memory and almost no CPU while idle; the main window only exists while it is open.

## Install

**Mac** (one line in Terminal; Terminal is in Applications > Utilities):

```bash
curl -fsSL https://raw.githubusercontent.com/GeorgeLnA/talkie/main/install-mac.sh | bash
```

**Windows** (one line in PowerShell; press the Windows key, type PowerShell, Enter):

```powershell
irm https://raw.githubusercontent.com/GeorgeLnA/talkie/main/install-windows.ps1 | iex
```

Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**. (The app is not yet signed with a paid certificate.)

Or download the files yourself from the [latest release](https://github.com/GeorgeLnA/talkie/releases/latest): `Talkie-mac-arm64.dmg` (Apple-chip Macs), `Talkie-mac-x64.dmg` (older Intel Macs), `Talkie-Setup-x64.exe` (Windows), `Talkie-linux-x86_64.AppImage` (Linux). A Mac app downloaded in a browser is blocked the first time: open System Settings > Privacy & Security, scroll down and click **Open Anyway**. The one-line installer avoids this.

## First run

1. Type your name and the team code you were sent.
2. Allow the microphone when asked. (Mac: if you missed it, System Settings > Privacy & Security > Microphone > turn on Talkie.)
3. Done. Talkie starts with your computer and lives in the menu bar (Mac) or system tray (Windows). Click its icon for chats and settings.

## Security

- **End-to-end encrypted.** Each time you talk, your computer makes a new random key, encrypts the voice with it (XSalsa20-Poly1305), and seals that key separately for each person you are talking to (X25519). The relay server only passes sealed packets along: it cannot hear anything, and nor can anyone who breaks into it.
- **Identity keys stay on your computer**: on Windows encrypted with the system keychain (DPAPI); on Mac and Linux in a file only your user account can read, the same way SSH keys are kept. Every connection proves who you are by signing a fresh random challenge; there are no passwords to steal.
- **Joining needs the team code**, which is only used once and then forgotten by the app. The server keeps only a salted hash of it and blocks repeated wrong guesses.
- **Safety codes.** Each person has a code (Settings, and People > Safety code). If the codes match in person, nobody is in the middle. If someone's key ever changes, Talkie warns you and will not send to them until you choose to trust it.
- **Speech to text and summaries happen on your Mac** (Apple's on-device speech recognition and, if switched on, Apple Intelligence). Text never goes to the relay or anywhere else.
- **The microphone is only on while you are talking** (and for a few seconds after you press the shortcut, so your first word is not cut off). The app is locked down: no remote web content, sandboxed pages, a strict content security policy, and only the microphone permission is ever granted.
- **What the relay does see:** who is on the team, who is online, who talks to whom and when, and how long. Messages for people who are offline are stored encrypted for up to 7 days, then deleted.
- Built on [TweetNaCl](https://tweetnacl.js.org) (audited) and Electron. Connections go over TLS.

## Run your own relay

The relay is a small Node.js program in `server/`.

```bash
cd server && npm install --omit=dev
TALKIE_TEAM_CODE=TK-ABCD-EFGH-JKLM TALKIE_PORT=8787 node index.js
```

Put it behind HTTPS (for example Caddy, nginx or a Cloudflare tunnel), then either point the app at it with the `TALKIE_SERVER=wss://your.host` environment variable, or change `DISCOVERY_URL` in `src/main/main.js`.

## Develop

```bash
npm install
npm test          # relay + encryption tests
npm start         # run the app
npm run dist:mac  # build installers into dist/
```

Releases are built for Mac, Windows and Linux by GitHub Actions when a `v*` tag is pushed.
