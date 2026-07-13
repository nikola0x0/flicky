# Sound sources

All files CC0 (public domain) — no attribution required; recorded for
provenance.

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
| bgm.mp3 | `Juhani Junkala [Retro Game Music Pack] Level 1.wav` | Juhani Junkala — 5 Chiptunes (Action) (opengameart.org/content/5-chiptunes-action, CC0) |

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
- `bgm.mp3`: the OpenGameArt "5 Chiptunes (Action)" page currently serves
  a zip whose contents are labelled "[Retro Game Music Pack]" by the same
  author (Juhani Junkala) — same CC0 grant, confirmed by the pack's
  `INFO.txt`. Of the 5 tracks (Title Screen, Level 1/2/3, Ending), the
  three "Level" tracks are the most loop-ready (steady loudness from
  sample zero, no fade-in intro); "Level 1" was picked as the neutral
  placeholder. Untouched audition candidates (Level 2, Level 3, Ending,
  Title Screen — converted to mp3) are left in the scratchpad, not
  committed, for the user to swap in later.

Converted to mp3 with ffmpeg (libmp3lame, -qscale:a 4). Original files
were `.ogg` (Kenney packs) and `.wav` (Junkala pack).
