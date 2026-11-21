# Changelog

## 0.1.4

- Fixed: changing the speed by voice or with a scene ("Hey Siri, increase fan speed", "set the fan to 66%") could make the fan fall back to its previous speed a few seconds later. Home sends these as "speed, then on", and the fan's firmware treats an "on" right after a speed change as "restore the old speed". The plugin now never sends "on" within 5 seconds of a speed change, and when the fan is off it sends "on" before the speed.

## 0.1.3

No changes to how the plugin works.

- Settings form: required fields are now declared the standard JSON Schema way, as Homebridge's verification checks expect. Email and password are still required.

## 0.1.2

No changes to how the plugin works.

- Declares that it publishes accessories over HomeKit (HAP), as Homebridge's plugin listing expects.
- Tested on Node.js 22, 24 and 26.

## 0.1.1

Fixes for every known issue in 0.1.0. No new settings.

- A fan removed and re-added in the My Superfan app reconnects by itself: the plugin signs in once to fetch its new keys, with no restart needed.
- A fan that can't be found at startup still appears in Home (as "No Response") and connects once it's found, without a restart.
- A problem setting up one fan no longer stops the other fans.
- A failed command puts the tile straight back to the fan's real state.
- An odd status reply from a fan counts as a failed check, never as "off".
- Unusual switch numbers from Superfan's servers are checked instead of guessed.
- Requests to a fan keep flowing if the server's clock is set back.
- Smaller package (no source maps). README: Node.js 22.12 or newer, and notes on removing or re-adding fans.

## 0.1.0

First release.

- Superfan smart fans appear in Apple Home as a Fan with on/off and a speed slider (one step per fan speed).
- Fans whose light is switchable from the My Superfan app also get a Light tile.
- One sign-in to your Superfan account at startup finds fans automatically; after that, all control is local over Wi-Fi.
- Works when Superfan's servers are down at startup, using the fan details saved from the last successful start.
- Status follows changes made from the remote or the app within a few seconds; unreachable fans show "No Response".
- Optional per-fan overrides for a fixed IP address and the model name.
