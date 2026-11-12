# DPet: a 2D/3D smart desktop pet for DSH

[中文](README.md)

DPet is a desktop-pet plugin for [DeepSeek Harness (DSH)](https://github.com/zhu1090093659/dsh-web). It turns **any character** (a 3D model, a picture, a GIF) into a pet floating over the DSH interface that **moves with what the AI is doing**: it turns while the AI thinks, hops while it runs commands, cheers when a task is done, and droops on errors.

The showcase character is Dong Xiaolong (东小龙), the mascot of Dalian Neusoft University of Information, generated from a picture with Tencent Hunyuan 3D.

## Features

- **2D and 3D**: 3D `.glb` models render in real time with three.js; 2D accepts PNG, JPG, WebP and GIF.
- **Drop in and go**: drag a file onto the settings page and it becomes a pet. No config files, no sprite sheets.
  - **3D models are slimmed down**: meshes are decimated and textures re-encoded. A 76 MB, 1.5M-triangle AI-generated model becomes 1.8 MB and 50k triangles in a few seconds, and a cover thumbnail is captured automatically.
  - **Pictures lose their plain background**: white or single-color backdrops are removed with soft, halo-free edges. Before the pet is created, the original and the cleaned picture are shown side by side so you can pick one. Busy backgrounds are left untouched.
  - GIFs keep their animation.
- **Picture to 3D pet in one click**: connect Tencent Hunyuan on the settings page's Keys tab with your own Tencent Cloud account, then pick a picture on the Pet tab and press Generate. Hunyuan builds the 3D model; the plugin downloads, decimates, compresses and imports it as an animated 3D pet. The floating pet shows the progress and cheers when it is done.
  - Two ways in: a **TokenHub API key** (how Tencent now offers Hunyuan) or a **Tencent Cloud API key** (SecretId / SecretKey). Rapid or Pro quality.
  - Keys stay on your computer and go only to Tencent Cloud; unfinished jobs resume after a DSH restart.
- **2D no longer feels like paper**:
  - **Jelly deformation**: the picture is cut into 40 horizontal strips placed by their height above the feet. Sways bend the body (feet stay, the head moves most), breathing lifts the chest, landings squash and rebound, and the upper body trails slightly behind.
  - **No card flips**: turns become a perspective tilt of at most 14 degrees.
  - **Contact shadow**: a soft shadow under the feet shrinks and fades during hops. 3D models get the same shadow.
- **One motion set for 2D and 3D**: breathe, look around, spin, hop, nod, cheer, droop, still.
- **Follows the agent**: DSH session events map onto seven states (idle, preparing, thinking, using tools, replying, done, error); pick the motion for each state in the motion editor.
- **Adaptive status bubble**: the bubble sits just above the pet's head, scales with the pet, and moves below it near the top of the screen.
- **Set it up by talking to the AI**: five agent tools let you say "switch to the flat Dong Xiaolong, make it bigger, nod while thinking" and the AI does it.
- **Right-click menu**: puts a ready-made prompt in the DSH input box (never sends, never overwrites your unsent text), plus bigger / smaller / back-to-corner shortcuts.
- **Respects the system "reduce motion" setting.**
- **Visual settings**: live preview stage, card gallery, drag-to-place, size and opacity sliders, look-at-cursor, status bubbles. The page uses the DSH design tokens and follows the light and dark themes.

## Install

Requires DSH 0.1.7-rc.1 or newer.

**From the Git repository (recommended)**: in the DSH plugin manager, install from a Git repository and enter `https://github.com/Rymascot/dsh-dpet`. The repository ships the built `lib/`, so nothing is compiled and no install scripts run.

**Local development install** (Node.js 22.19+ and pnpm):

```bash
git clone https://github.com/Rymascot/dsh-dpet.git
cd dsh-dpet
pnpm install
pnpm build
dsh plugin --profile web add link:/path/to/dsh-dpet
```

Restart DSH. Dong Xiaolong appears at the bottom right, and Settings gains a "桌宠" (Desktop Pet) page.

**Updating**: Git installs stay on the installed version. Run `dsh plugin --profile <profile> update dsh-dpet` (`web` or `desktop`), then restart DSH. The desktop app keeps running in the system tray when its window closes: quit it from the tray icon (or Task Manager) and open it again, or the new version will not load.

## Development

```bash
pnpm typecheck
pnpm test        # unit tests + route integration tests
pnpm build       # lib/: host half, browser half, three.js vendor bundle
```

`lib/` is committed: Git installs use it as is. After changing `src/`, run `pnpm build` and commit `lib/` together with the sources (source maps stay out of the repository).

Set `DPET_HUNYUAN_MOCK=1` before starting DSH to try image-to-3D without a key or network: the built-in Dong Xiaolong model stands in for the result.

Settings live in `$DSH_HOME/dpet/settings.json` and imported pets in `$DSH_HOME/dpet/pets/`. See the Chinese README for a file-by-file map.

## Privacy

The plugin reads only the agent's activity state (thinking, tool names, turn end), never chat content, and has no telemetry; imports and optimization run locally. **Only image-to-3D uses the network**: when you press Generate (or ask the AI to call `dpet_generate_3d`), that one picture goes to Tencent Hunyuan and the model is downloaded back. Hunyuan keys are entered on the settings page's Keys tab, saved only in `$DSH_HOME/dpet/credentials.json`, sent only to Tencent Cloud, and never returned to the page or given to the AI. Endpoints are loopback-only with same-origin writes, prompts are never sent automatically, and the AI changes the pet only through the five DPet tools.

A Chinese user guide is in [TUTORIAL.md](TUTORIAL.md).

## License

Code: [Apache-2.0](LICENSE). Third-party components and assets: see [NOTICE](NOTICE).

**The Dong Xiaolong character is not covered by the code license**: it belongs to Dalian Neusoft University of Information. This project only has the university's permission to use it and cannot grant any rights in it to others; it is shown as a non-commercial student work and must not be extracted or redistributed. See `assets/pets/dongdong/NOTICE.md`.
