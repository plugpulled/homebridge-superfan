# homebridge-superfan

Control your **Superfan** smart ceiling fans from **Apple Home** and Siri, using [Homebridge](https://homebridge.io).

Superfan's own app works with Google Home and Alexa, but not Apple Home. This plugin fills that gap. After a one-time sign-in to your Superfan account at startup, it talks to your fans **directly over your home Wi-Fi**, so taps in the Home app are fast and keep working even when the internet is down.

> **Unofficial.** This plugin is not made, endorsed or supported by Superfan (Versa Drives Pvt Ltd) or KIOT. It uses the fan's local network API. Use it at your own risk.

## What you get in Apple Home

| Superfan feature | In Apple Home |
|---|---|
| Fan on/off | ✅ Fan tile |
| Fan speed | ✅ Speed slider, one position per speed step your fan supports (e.g. 3 on the Super Q) |
| Status changes from the remote or the Superfan app | ✅ Shown in Home within a few seconds |
| Fan light | ✅ Light tile, **only** for fans whose light can be switched from the Superfan app. Lights that only work from the physical IR remote cannot be controlled. |
| Modes (Boost, Sleep…), timer, RPM | ❌ Not supported |

**Tested with:** Superfan Super Q (firmware 4.2.0). Other Superfan smart fans that use the "My Superfan" app should work. If yours doesn't, please [open an issue](https://github.com/plugpulled/homebridge-superfan/issues).

## Requirements

- Homebridge 1.8 or newer (2.x supported), Node.js 22.12 or newer
- Your fan already set up in the **My Superfan** app and connected to your Wi-Fi
- Homebridge on the **same network** as the fans
- A Superfan account that signs in with **email and password**

## Install

**Homebridge UI (recommended):** open the **Plugins** tab, search for **Superfan**, and install **Homebridge Superfan**.

**Command line:**

```sh
npm install -g homebridge-superfan
```

## Configure

In the Homebridge UI, open the plugin's **Settings** and enter the email and password you use in the My Superfan app. Restart Homebridge. Your fans appear in the Home app under the Homebridge bridge.

Or add this to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Superfan",
      "email": "you@example.com",
      "password": "your-superfan-password"
    }
  ]
}
```

| Setting | Required | Default | What it does |
|---|---|---|---|
| `email` | yes | | Your My Superfan login email |
| `password` | yes | | Your My Superfan password |
| `pollInterval` | no | `5` | Seconds between status checks (2 to 300) |
| `devices` | no | | Per-fan overrides, see below |

### Per-fan overrides (optional)

```json
"devices": [
  { "deviceId": "0123456789ab", "host": "192.168.1.50", "model": "Superfan Super Q" }
]
```

- `deviceId`: the fan's 12-character ID. It's printed in the Homebridge log, e.g. `"Bedroom Fan" (device ID 0123456789ab) ready at 192.168.1.50`.
- `host`: a fixed IP address for the fan. Use this if the fan can't be found automatically. Giving the fan a DHCP reservation in your router is a good idea.
- `model`: the model name shown in the Home app's accessory details.

## How it works

1. When Homebridge starts, the plugin signs in to your Superfan account **once**. It reads your fans, their local access keys and their IP addresses, and saves them to a file in Homebridge's storage folder that only the Homebridge user can read.
2. From then on, every command and status check goes **directly to the fan on your network**. Nothing passes through Superfan's servers.
3. If Superfan's servers are unreachable when Homebridge starts, the plugin uses the saved details from the last successful start.

## Troubleshooting

**"Superfan login failed: check email/password"**: make sure you can sign in to the My Superfan app with the same email and password. Accounts that sign in only with an OTP or Truecaller aren't supported.

**"Could not find … on the network"**: Homebridge can't reach the fan. If Homebridge runs in **Docker**, use host networking (`network_mode: host`) or set the fan's `host` in the settings. Also check that the fan and Homebridge are on the same network or VLAN.

**Fan shows "No Response" in Home**: the fan isn't answering on the network. This happens, for example, when it's switched off at the wall. It recovers automatically within about 30 seconds of coming back.

**A fan is "skipped"**: your fan reports a switch layout this plugin doesn't support yet. Please open an issue with the log line.

**Removed a fan from your Superfan account?** It disappears from Home the next time Homebridge restarts. If it was your only fan, the plugin keeps it, in case Superfan's servers reported no fans by mistake. To remove it for good, delete the `superfan` folder in Homebridge's storage folder, remove the fan's cached accessory in the Homebridge UI settings, and restart Homebridge.

**Removed and re-added a fan in the Superfan app?** The fan gets new keys. The plugin notices within a few polls, signs in once to fetch them, and carries on, with no restart needed.

## Privacy and security

- Your email and password are stored in Homebridge's `config.json`, like any other plugin's settings. Protect access to your Homebridge server.
- The saved fan details include the fans' local access keys. They're stored with owner-only file permissions inside the Homebridge storage folder.
- The plugin never logs your password, tokens or fan keys. It talks only to Superfan's servers (at startup) and to your fans on your local network.

## License

[MIT](LICENSE) © 2026 Hanif Roshan
