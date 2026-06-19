# BlackFossil Overlay

A free, open-source desktop overlay for **The Isle: Evrima**, built by the BlackFossil community server.

Maintained by **[@HidekiSensei](https://github.com/HidekiSensei)**.

## Features

- 🎙️ **Proximity voice chat** — talk to nearby players, volume scales with in-game distance (self-hosted LiveKit)
- 🗺️ **Map** — large map with PVP/PVE zones, your position, and waypoints
- 📍 **Minimap** — always-on-top minimap with a live zone indicator
- 🔥 **Heatmap** — toggle an activity heatmap on the big map
- ⌨️ **Global hotkeys** — connect/disconnect, mic, settings, map

## Project structure

- `app/` — the Electron overlay application (this is what players install)
- `token-service/` — backend service: Discord login → LiveKit token + player positions relay

## Tech

Electron · LiveKit · Node.js · esbuild

## License

[MIT](LICENSE) — free and open source. This software is **not** distributed commercially.

## Downloads

Windows installers are published under [Releases](https://github.com/HidekiSensei/blackfossil-overlay/releases).
