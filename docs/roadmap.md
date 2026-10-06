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
not touching files the \*arr apps are mid-import, and surviving a run that spans days.

*Today:* [Tdarr or Unmanic](comparison.md#tdarr-and-unmanic) do exactly this, and do it well. Rexarr covers new
arrivals and anything you select by hand in the library.

## Medium

### Data discs as ISO backups

A disc that is neither video nor audio is currently ignored. Copying it to an `.iso` next to the rips — the way
[Automatic Ripping Machine](comparison.md#automatic-ripping-machine) does — is a small pipeline of its own:
detect that there are no titles, read the disc, verify the copy, and name it something sensible.

*Today:* back it up with MakeMKV's own backup mode, `dd`, or ARM.

## Smaller

### Notifications

Telling you when a rip or an encode finished, when one failed, or when a new version is out — through
[Apprise](https://github.com/caronc/apprise)-style targets: Discord, Slack, Pushbullet, IFTTT, Gotify, ntfy, plain
webhooks. The plumbing is already there (every job and rip is an event in **System → Events**); what is missing is
the delivery and the settings page.

*Today:* **System → Events** has the history, **System → Updates** says when a release is out, and Radarr / Sonarr
will notify you themselves when the import lands.

## Ask for something else

Open a [feature request](https://github.com/MoonlightLaboratory/rexarr/issues/new?template=feature_request.yml) —
what you are trying to do and what gets in the way is more useful than a solution, because the answer is sometimes
a setting that already exists.

Bugs go through [the same place](https://github.com/MoonlightLaboratory/rexarr/issues/new/choose), and
**System → Status → Report an issue** fills in your version, platform and install method for you.
