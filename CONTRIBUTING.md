# Adding a disc

You need the disc, and the patience to check which episode is which. That is the whole barrier — there is no
account, no API key, and nothing to install.

## 1. Find the numbers

Put the disc in and scan it with whatever you use. You want, for each title the disc offers:

- its **index** — the number the disc itself uses, counting from 0
- what it **is** — an episode, a season-0 special, an extra, or the "play all" compilation

If your ripper shows durations, note them: `titleCount` and `durationsSeconds` make a fingerprint, which is how a
disc gets recognised with nobody having to scan a barcode. **Only add a fingerprint you read off the disc.** It is
the field most likely to be matched automatically, so a wrong one is worse than a missing one.

The barcode on the case is worth ten minutes of anything else. Add it if you have the case.

## 2. Write the file

Copy the nearest existing entry. Entries live at:

```
discs/tv/<series-slug>-<tvdbId>/s<season>d<disc>.json
discs/movies/<title-slug>-<year>/d<disc>.json
```

so `discs/tv/sword-art-online-259640/s02d02.json`. The path is for humans; nothing reads it.

Rules the checker enforces, so you do not have to remember them:

- an entry needs **something to be found by** — a barcode, a label, or a fingerprint
- a series needs **at least one id** (TVDB, TMDB, IMDb or AniDB). Titles get renamed; ids do not
- a title is **one thing**: an episode, or a special, or an extra, or a play-all
- the same episode cannot be on **two titles** of one disc — if it looks like it is, one of them is the play-all

## 3. Check it

```bash
node scripts/validate.mjs
```

No install. It checks every entry and rewrites `index.json`; commit that too.

## 4. Open a pull request

Say which disc you have and how you know. "I own it and watched the first minute of each title" is a better
reason than anything else you could write.

## What not to add

**Arithmetic.** If you worked out that disc 3 must be episodes 15–19 because discs 1 and 2 had seven each, that
is a guess, and software can already guess. This database is only worth reading because everything in it came
from somebody looking at a disc. An entry you are unsure of is worse than no entry, because it will be applied
silently and trusted.

Leave the disc out. Someone who owns it will add it.
