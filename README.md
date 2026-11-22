# Talkie

Push-to-talk for your team. Press a shortcut from any app, speak, press it again: your voice comes out of your teammates' speakers. If they are on Do Not Disturb, it waits for them as a message behind a bright green box in the corner of their screen, and they play it with one click without leaving what they are doing.

- **Talk from anywhere:** `Cmd+Shift+Space` (Mac) or `Ctrl+Shift+Space` (Windows) starts talking; press again to send. Or hold the big button in the app.
- **Pick who hears it:** tick one person or several in the list. Group talk is just ticking more names.
- **Do Not Disturb:** voice arrives as a message instead of playing out loud. A green box appears top left: **Play**, **Wait 5 min** (the sender is told), **Later**, or **Reply**. The sender sees that you are on DND before they start.
- **Walkie-talkie sounds:** a chirp when someone starts talking, a roger beep when they finish.
- **Messages:** everything is kept in the app for replay. If someone is offline, it is delivered when they come back.
- **Always there:** a small green dot sits in the top left corner of your screen (over full-screen apps too). Hover it to see who is online, click it to open Talkie.

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
3. Done. Talkie starts with your computer and lives in the menu bar (Mac) or system tray (Windows), with the green dot top left.

## Security

- **End-to-end encrypted.** Each time you talk, your computer makes a new random key, encrypts the voice with it (XSalsa20-Poly1305), and seals that key separately for each person you are talking to (X25519). The relay server only passes sealed packets along: it cannot hear anything, and nor can anyone who breaks into it.
- **Identity keys stay on your computer**, encrypted with your system keychain (macOS Keychain, Windows DPAPI). Every connection proves who you are by signing a fresh random challenge; there are no passwords to steal.
- **Joining needs the team code**, which is only used once and then forgotten by the app. The server keeps only a salted hash of it and blocks repeated wrong guesses.
- **Safety codes.** Each person has a code (Settings, or click "i" next to a name). If the codes match in person, nobody is in the middle. If someone's key ever changes, Talkie warns you and will not send to them until you choose to trust it.
- **The microphone is only on while you are talking.** The app is locked down: no remote web content, sandboxed pages, a strict content security policy, and only the microphone permission is ever granted.
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
