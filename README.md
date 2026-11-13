# Production Comms

Touch-based crew communications for theater, live events, film/TV and broadcast.
Runs on one computer; every tablet, phone and laptop on the same network opens it in a browser. Nothing to install on the devices.

## Features
- **Cue pad**: big one-tap buttons (Standby, GO, Hold, Places, Rolling, Cut, EMERGENCY STOP…). You can add an optional cue number such as "LX 42". Buttons are editable and shared with everyone.
- **Full-screen alerts**: incoming cues take over the screen with a sound and a vibration (on Android), plus a big ACKNOWLEDGE button. Urgent cues flash red.
- **Channels**: All Call plus one per department. You can create your own channels and send direct messages.
- **Acknowledgements**: every cue, and any chat message with "Ack?" turned on, tracks who has confirmed. The Board shows who you're still waiting on.
- **Crew board**: everyone grouped by department, showing online/offline, status (Ready / Standby / Busy / Break / Away / Emergency) and who's talking.
- **Push-to-talk**: hold the round button, or the space bar on a keyboard, to talk to a channel or a person. Latch mode is in the profile menu.

## Run it
Requires Node.js 18+.

```bash
npm install
npm run cert      # one time: makes an HTTPS certificate (needed for mic on phones/tablets)
npm start
```

The server prints the addresses to use. Use the **https://…:8443** address on phones and tablets. Each device shows a security warning once; accept it.

Options (environment variables): `SHOW_NAME="Hamlet – Main Stage"`, `SHOW_PASSCODE=1234`, `PORT`, `HTTPS_PORT`, `DATA_FILE`.

Tip: on iPad/iPhone use Share → *Add to Home Screen* to get a full-screen app icon.

## Test
```bash
npm test
```

## Limits of this version
- Built for one local network (LAN/Wi-Fi). It isn't hardened for the public internet.
- The passcode is the only access control. Anyone with the passcode can edit buttons and channels.
- Audio is uncompressed 16 kHz mono (about 256 kbps per talker), which suits Wi-Fi but isn't broadcast-grade intercom.
- iOS doesn't vibrate from web pages, and the screen must be on/open to receive alerts.
