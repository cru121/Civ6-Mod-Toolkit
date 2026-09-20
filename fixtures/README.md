# fixtures

The verification scripts (`npm run phase0` / `phase1` / `phase2`) read sample
`.Civ6Cfg` files from this folder. None are shipped, because a real config
embeds your game/session name.

To run the checks, drop a few of your own `.Civ6Cfg` files here (copy them from
your `…\My Games\Sid Meier's Civilization VI\Saves\Single` folder). They are
git-ignored, so they will never be committed.

The app itself (`npm start` / the launcher) does **not** need this folder — it
reads configs directly from your Saves folder at runtime.
