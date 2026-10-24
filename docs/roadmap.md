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

### 3D, IMAX and open-matte

A Blu-ray's MVC stream, and a transfer whose aspect ratio changes partway through, are both things worth knowing
about and neither is in a filename today. Detecting them and keeping them there — so a player and a human can both
tell what they have — is mostly a naming and metadata job once the detection is right.

### Data discs as ISO backups

A disc that is neither video nor audio is currently ignored. Copying it to an `.iso` next to the rips — the way
[Automatic Ripping Machine](comparison.md#automatic-ripping-machine) does — is a small pipeline of its own:
detect that there are no titles, read the disc, verify the copy, and name it something sensible.

*Today:* back it up with MakeMKV's own backup mode, `dd`, or ARM.

### Disc menus

Keeping a disc's menu — as a looping video or a few stills — so the shelf has something of the object on it, not
only the film.

What makes this hard is the discs themselves. MakeMKV does not rip menus at all, so a DVD's would have to be read
straight out of `VIDEO_TS` with something else; and a Blu-ray's menu is not video but a BD-J application — a Java
program drawing itself — which cannot be archived as a loop in any meaningful sense. So the honest version of
this is DVD-only and still only a picture of a menu, with the "virtual disc" part of it a page of its own in the
UI. Worth doing one day; worth being clear that it is not the same thing as the menu working.

*Today:* MakeMKV's backup mode keeps the whole disc, menus and all, and a player that reads the folder will play
them properly.

### Subtitles when the disc has none

Pulling a missing language from OpenSubtitles and shifting it onto the disc's timing with ffsubsync or alass.

The reason this has not been built is that **[Bazarr](guide/disc-ripping.md#subtitles-with-bazarr) already does
exactly this, properly** — several providers rather than one, scoring, upgrades, per-language rules — and Rexarr
now tells it about a disc the moment the disc is imported. A second subtitle sourcer inside Rexarr would be a
worse one, and would need its own OpenSubtitles account, its own rate limiting, and ffsubsync or alass installed
besides.

Where it might still earn a place: the disc knows things Bazarr does not. Which languages were on it, which are
forced, and the exact runtime of the title that was ripped are all better sync anchors than a file on disk. Handing
*that* to Bazarr, rather than duplicating it, is the version of this idea worth building.

*Today:* set up Bazarr and fill in **Settings → Connections → Bazarr**.

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
