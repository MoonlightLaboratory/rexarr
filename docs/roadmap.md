# Roadmap

What is being considered, roughly in the order of how much work it is. Nothing here has a date, and nothing here is
a promise — it is a list of what Rexarr is missing that people ask for most.

!!! warning "Stability first, while Rexarr is in beta"
    A feature that half works is worse than one that does not exist yet, especially in something that moves and
    deletes your files. Until Rexarr is out of beta, **fixing what is already there comes before anything on this
    page** — a bug report is worth more to the project right now than a feature request, and the two are not
    competing for the same time.

## Big

### A library optimiser option

Point Rexarr at a library and let it work through everything in it to a target codec on a schedule, rather than
only encoding what Radarr and Sonarr have just imported. It would reuse what already exists — the
[profiles](guide/profiles.md), the queue, and the history that
[auto transcode](guide/auto-transcode.md) keeps so a file is never encoded twice — with a cap per run, a preview of
what would be queued, and the ability to stop halfway without leaving a mess.

The hard parts are the ones that make this a "big" item: knowing when a file is already good enough to leave alone,
not touching files the \*arr apps are mid-import, and surviving a run that spans days. The first of those is
partly answered already — a [smart profile](guide/profiles.md#smart-profiles) can ask about a file's codec,
bitrate, bit depth and audio before deciding what to do with it — which is a piece of the groundwork rather than
the feature itself.

*Today:* [Tdarr or Unmanic](comparison.md#tdarr-and-unmanic) do exactly this, and do it well. Rexarr covers new
arrivals and anything you select by hand in the library.

### Re-rip upgrades

A disc you already own, bought again on better media: the DVD becomes a Blu-ray, the Blu-ray becomes a UHD. Rexarr
knows what the old file was and what the new disc is, so it could swap the one for the other and either archive the
old file or delete it — rather than leaving two copies and letting Sonarr or Radarr pick a winner.

The hard parts are the ones that decide whether this is safe: being certain the new rip is genuinely better (a
1080p remux is not always an upgrade on a well-encoded 1080p file), not deleting the only copy if the rip turns out
to be faulty, and telling the \*arr apps about the swap so their history is not a lie. Deleting the user's media is
the one thing this project must never get wrong, so an archive-first default and a dry run come before the delete.

*Today:* rip the better disc and let Radarr or Sonarr upgrade it by its own quality profile, then remove the old
file yourself.

### Collection tracking

"You own 6 of 8 Studio Ghibli Blu-rays." A shelf is a collection with holes in it, and Rexarr is the only thing
that knows what is actually on the shelf — it has seen every disc you have put in a drive. Joining that to a
collection (TMDB has them, and so do the \*arr apps) would turn the gaps into something actionable, linked to the
Radarr wanted list.

The hard part is what counts as owned. A disc you ripped once and a file that came from elsewhere are not the same
claim, and a collection's membership is a matter of opinion once box sets, re-releases and regional cuts are in
play.

*Today:* the **Insert disc for…** experiment on the Discs page is the nearest thing — it lists what the \*arr apps
are still hoping to improve and what kind of disc would improve it.

## Medium

### Crop detection

Letterboxed transfers carry black bars in the picture. FFmpeg can measure them (`cropdetect`), so a profile could
remove them during the encode and save the bitrate spent on black.

The hard part is knowing when not to. A film with a variable aspect ratio — IMAX sequences, an open-matte insert —
will measure differently in different scenes, and cropping to the first measurement ruins it. So: sample across the
file rather than the first minute, do nothing when the samples disagree, and always allow a manual override.

### 3D, IMAX and open-matte

A Blu-ray's MVC stream, and a transfer whose aspect ratio changes partway through, are both things worth knowing
about and neither is in a filename today. Detecting them and keeping them there — so a player and a human can both
tell what they have — is mostly a naming and metadata job once the detection is right.

### Bazarr

Rexarr knows a rip has landed and which episode or film it is, which is exactly what Bazarr needs to go looking for
subtitles. Handing the finished file over, rather than waiting for Bazarr's own scan to notice it, closes the gap
between a disc going in and the subtitles being there.

*Today:* Bazarr finds it on its next scan.

### Keyboard shortcuts and a command palette

The search box already answers `/` and `Ctrl/Cmd + K`. A palette that goes further — jump to a page, start a rip,
pause the queue — and shortcuts for what a power user does repeatedly.

### Data discs as ISO backups

A disc that is neither video nor audio is currently ignored. Copying it to an `.iso` next to the rips — the way
[Automatic Ripping Machine](comparison.md#automatic-ripping-machine) does — is a small pipeline of its own:
detect that there are no titles, read the disc, verify the copy, and name it something sensible.

*Today:* back it up with MakeMKV's own backup mode, `dd`, or ARM.

## Small

### A warning when a drive cannot read UHD discs

Most drives cannot read a UHD Blu-ray at all, and the ones that can usually need particular firmware. Rexarr knows
the drive's model, so it could say so when a UHD disc goes into a drive that will not read it, instead of letting
the read fail and leaving you to work out why — with a link to the drive list MakeMKV's forum keeps.

### Naming that suits Plex and Jellyfin better

Ripped files are named one fixed way — `Naruto - S01E05 - DVD.mkv`, with extras in an `Extras` folder beside the
show. The source suffix is useful when two rips of the same episode exist and noise when they do not, and the
shape is not what every library wants. A template per kind, with the suffix optional, would let the files land the
way your server already expects them.

## Ask for something else

Open a [feature request](https://github.com/MoonlightLaboratory/rexarr/issues/new?template=feature_request.yml) —
what you are trying to do and what gets in the way is more useful than a solution, because the answer is sometimes
a setting that already exists. If it is still a half-formed thought, [Discussions →
Ideas](https://github.com/MoonlightLaboratory/rexarr/discussions/categories/ideas) is the place for it.

Bugs go through [the same place](https://github.com/MoonlightLaboratory/rexarr/issues/new/choose), and
**System → Status → Report an issue** fills in your version, platform and install method for you.
