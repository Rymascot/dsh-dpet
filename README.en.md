# DPet: a 2D/3D smart desktop pet for DSH

[中文](README.md)

DPet is a desktop-pet plugin for [DeepSeek Harness (DSH)](https://github.com/zhu1090093659/dsh-web). It turns **any character** (a 3D model, a picture, a GIF) into a pet floating over the DSH interface that **moves with what the AI is doing**: it turns while the AI thinks, hops while it runs commands, cheers when a task is done, and droops on errors.

The showcase character is Dongdong, the mascot of Dalian Neusoft University of Information, generated from a picture with Tencent Hunyuan 3D.

## Features

- **2D and 3D**: 3D `.glb` models render in real time with three.js; 2D accepts PNG, JPG, WebP and GIF.
- **Drop in and go**: drag a file onto the settings page and it becomes a pet. No config files, no sprite sheets.
  - **3D models are slimmed down**: meshes are decimated and textures re-encoded. A 76 MB, 1.5M-triangle AI-generated model becomes 1.8 MB and 50k triangles in a few seconds, and a cover thumbnail is captured automatically.
  - **Pictures lose their plain background**: white or single-color backdrops are removed with soft, halo-free edges. Before the pet is created, the original and the cleaned picture are shown side by side so you can pick one. Busy backgrounds are left untouched.
  - GIFs keep their animation.
- **2D no longer feels like paper**:
  - **Jelly deformation**: the picture is cut into 40 horizontal strips placed by their height above the feet. Sways bend the body (feet stay, the head moves most), breathing lifts the chest, landings squash and rebound, and the upper body trails slightly behind.
  - **No card flips**: turns become a perspective tilt of at most 14 degrees.
  - **Contact shadow**: a soft shadow under the feet shrinks and fades during hops. 3D models get the same shadow.
- **One motion set for 2D and 3D**: breathe, look around, spin, hop, nod, cheer, droop, still.
- **Follows the agent**: DSH session events map onto seven states (idle, preparing, thinking, using tools, replying, done, error); pick the motion for each state in the motion editor.
- **Adaptive status bubble**: the bubble sits just above the pet's head, scales with the pet, and moves below it near the top of the screen.
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

Restart DSH. Dongdong appears at the bottom right, and Settings gains a "桌宠" (Desktop Pet) page.

## Development

```bash
pnpm typecheck
pnpm test        # unit tests + route integration tests
pnpm build       # lib/: host half, browser half, three.js vendor bundle
```

`lib/` is committed: Git installs use it as is. After changing `src/`, run `pnpm build` and commit `lib/` together with the sources (source maps stay out of the repository).

Settings live in `$DSH_HOME/dpet/settings.json` and imported pets in `$DSH_HOME/dpet/pets/`. See the Chinese README for a file-by-file map.

## License

Code: [Apache-2.0](LICENSE). Third-party components and assets: see [NOTICE](NOTICE).

**The Dongdong character is not covered by the code license**: it belongs to Dalian Neusoft University of Information and is shown as a non-commercial student work. See `assets/pets/dongdong/NOTICE.md`.
