# Sound sources

All SFX are CC0 (public domain) — no attribution required; recorded for
provenance. `bgm.mp3` is Uppbeat-licensed (free tier), which requires
visible attribution — see its own note below. The required credit is
rendered in-app in `apps/web/src/components/menu-modal.tsx`; do not
remove it without replacing the track or upgrading the license.

| File | Original source file | Pack |
|---|---|---|
| click.mp3 | `click_001.ogg` | Kenney — Interface Sounds (kenney.nl/assets/interface-sounds, CC0) |
| modal-open.mp3 | `open_001.ogg` | Kenney — Interface Sounds (kenney.nl/assets/interface-sounds, CC0) |
| modal-close.mp3 | `close_001.ogg` | Kenney — Interface Sounds (kenney.nl/assets/interface-sounds, CC0) |
| card-win.mp3 | `confirmation_001.ogg` | Kenney — Interface Sounds (kenney.nl/assets/interface-sounds, CC0) |
| card-loss.mp3 | `error_001.ogg` | Kenney — Interface Sounds (kenney.nl/assets/interface-sounds, CC0) |
| swipe-up.mp3 | `phaserUp1.ogg` | Kenney — Digital Audio (kenney.nl/assets/digital-audio, CC0) |
| swipe-down.mp3 | `phaserDown1.ogg` | Kenney — Digital Audio (kenney.nl/assets/digital-audio, CC0) |
| match-found.mp3 | `twoTone1.ogg` | Kenney — Digital Audio (kenney.nl/assets/digital-audio, CC0) |
| duel-win.mp3 | `jingles_NES00.ogg` (8-Bit jingles) | Kenney — Music Jingles (kenney.nl/assets/music-jingles, CC0) |
| duel-lose.mp3 | `jingles_NES02.ogg` (8-Bit jingles) | Kenney — Music Jingles (kenney.nl/assets/music-jingles, CC0) |
| bgm.mp3 | "Boogie" by Pecan Pie (Uppbeat, free tier) | Uppbeat — uppbeat.io/t/pecan-pie/boogie |

Notes:
- `duel-win.mp3` / `duel-lose.mp3`: the Kenney Music Jingles pack ships
  generic numbered stingers (no `Jingle_Win_*` / `Jingle_Lose_*` names).
  No audio playback tool was available, so picks were not made by ear:
  spectrogram analysis was inconclusive, and the actual pick came from
  an `ffmpeg volumedetect` loudness-envelope comparison (first-third vs
  last-third loudness) across the "8-Bit jingles" folder. `jingles_NES00`
  stays flat/sustained end-to-end (mapped to "win" — reads as a fuller
  fanfare); `jingles_NES02` decays sharply toward silence (mapped to
  "lose" — reads as a deflating "womp"). This is an unlistened judgment
  call worth a human audio review/swap later, same as `bgm.mp3` below.
- `bgm.mp3`: replaced the auto-picked Junkala placeholder with a track the
  user chose directly — "Boogie" by Pecan Pie, downloaded from Uppbeat
  under the free-tier Creator license (source file
  `Boogie Pecan Pie 41135.mp3`, ~135s, re-encoded the same way as every
  other asset: `ffmpeg -vn -codec:a libmp3lame -qscale:a 4`, dropping the
  embedded cover-art video stream from the original). NOT CC0 — Uppbeat's
  free tier requires a visible, per-download attribution credit:

  > Music from #Uppbeat (free for Creators!):
  > https://uppbeat.io/t/pecan-pie/boogie
  > License code: 7JEHN7VMRUTPZCDU

  This credit is rendered in-app (menu modal) to satisfy that requirement.
  If `bgm.mp3` is ever swapped again, either move the credit to match the
  new track's license or remove it if the replacement is CC0.

Converted to mp3 with ffmpeg (libmp3lame, -qscale:a 4). Original files
were `.ogg` (Kenney packs) and `.wav` (Junkala pack).
