# Relay Demos

Playable builds of three relay-game prototypes, served by GitHub Pages:

- **Echowake** (`echowake/`): a daily dungeon seed; runners leave traps for the next runner.
- **Relay Golf** (`golf/`): a daily three-hole course in 3D; golfers shape holes for the golfers behind them.
- **Relay Moto** (`moto/`): deterministic motocross; riders build pieces into the track for the next rider.

Everything runs in the browser and is kept in its localStorage, so each browser holds its own chains (play with
different names on one device to pass a chain along). Echowake normally runs on a server; here the same game code
answers its calls inside the page (`echowake/echowake-api.js`), with the dev clock on: the lobby's Next day closes
today's seeds, so you can see results unseal and practise on them.

This repo is generated. The sources live in the main project, and `node demos/build.js <this checkout>` rebuilds it.
Edits made here are overwritten by the next build.
