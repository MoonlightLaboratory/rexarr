# RexDB

**A crowdsourced map of which episode is on which part of which disc.**

A disc does not say what is on it. The volume label is a 32-character guess (`SWORD_ART_ONLINE_2_P1`), the titles
are numbered from zero in whatever order they were authored, and nothing anywhere says that part 2 of a set starts
at episode 8 rather than episode 6. So every ripper guesses, and the usual guess — *(disc − 1) ×
episodes-on-this-disc + 1* — is wrong the moment a set runs 7 + 7 + 5 + 5 instead of four equal discs.

Somebody has already worked it out for that disc, by hand, with the case in front of them. RexDB is where that
goes, so the next person does not do it again.

## How it is meant to work

1. A disc goes in and is scanned.
2. Rexarr looks it up in RexDB by [fingerprint](FINGERPRINT.md).
3. No match, so it guesses from TMDB, TVDB or AniDB, the way it always has.
4. The guess is wrong, and the episode numbers are corrected by hand.
5. Rexarr asks whether to send the correction here. Nothing leaves the machine unless the answer is yes.
6. The next person with that disc gets the right answer without being asked anything.

Step 5 is the whole project. Everything else is plumbing.

## How a disc is recognised

The key is a **fingerprint**: the volume label plus the playlist structure — how many titles and how long each
one is — hashed together. [FINGERPRINT.md](FINGERPRINT.md) is the exact definition, because two implementations
have to agree on it to the character.

It is built that way on purpose:

- **It needs nothing from the user.** No barcode to scan, no case to find. It is known the moment the scan ends.
- **A generic label cannot collide.** Hundreds of discs are called `DISC_1`; none of them share a structure.
- **Two regional pressings stay apart.** Same season, same runtimes, different episodes on the disc — the label
  is in the hash, so they are different keys.

`disc_name` is kept in the open alongside it, readable and searchable, and so is the structure the hash was built
from, so a near miss can still be offered as a suggestion when a drive reports a duration a second out.

## What an entry holds

```json
{
  "schema": 1,
  "status": "verified",
  "fingerprint": "63f07bfa4a431fd1",
  "disc_name": "SWORD_ART_ONLINE_2_P4",
  "series": { "title": "Sword Art Online", "year": 2012, "tvdb": 259640 },
  "disc": 4,
  "structure": { "titleCount": 5, "titles": [{ "key": "0", "seconds": 1417 }] },
  "titles": { "0": "S02E20", "1": "S02E21" },
  "confirmations": 3
}
```

A title is `S02E20`, or `S00E12` for a special, or `S01E04-E05` for a double, or `extra:op`, or `playall`, or
`skip`. Nothing else is stored: no file paths, no library, no user, no machine.

## What a client does with it

Lookup order, highest first:

1. **RexDB** — an exact fingerprint match on a `verified` entry
2. **A local override** — what this user set by hand for this disc, which always wins over anything downloaded
3. **The metadata guess** — TMDB, TVDB, AniDB, and the arithmetic

Whatever is used, the result says where it came from, so *from RexDB* is visible rather than assumed. A
`disputed` entry, or a structure near-miss, is shown as a suggestion and never applied on its own.

## Trust

- An entry is **unverified** on its first submission.
- It becomes **verified** when two or three independent submissions agree.
- Submissions that disagree make it **disputed** and nothing is applied automatically. They are never silently
  overwritten — the point of disagreement is that somebody has to look.
- `pending/` holds mappings somebody knows without having had the disc in a drive. They have no fingerprint, so
  they cannot be matched; they are a queue for whoever owns that disc.

Git history is the audit trail. Every change has an author, a date and a diff, for free.

## Privacy

Opt-in, with a prompt every time. What is sent is the fingerprint, the disc name, the series id and the mapping.
What is not sent is anything else: no paths, no library contents, no identifier for the machine or the person.

## Where it is published

The site is served as part of Rexarr's documentation, at
**<https://moonlightlaboratory.github.io/rexarr/rexdb/>**. There is one GitHub Pages site per repository, and the
documentation is already it, so this branch does not deploy anything of its own — the documentation workflow
copies the three files that make up the page into the published site. The page then reads this branch directly,
so contributing a disc shows up without anything rebuilding.

## Using the data

Plain files, no API, no account:

```
https://moonlightlaboratory.github.io/rexarr/rexdb/    the searchable site
https://raw.githubusercontent.com/MoonlightLaboratory/rexarr/RexDB/index.json
https://raw.githubusercontent.com/MoonlightLaboratory/rexarr/RexDB/discs/63/63f07bfa4a431fd1.json
```

`index.json` carries every entry's fingerprint, name, structure and status, so one small fetch answers whether a
disc is known. A client should cache it and re-read it on a schedule, not per disc.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Copy an entry, make it match the disc in your hand, open a pull request. The
checker runs with no dependencies: `node scripts/validate.mjs`.

## Licence

[CC0](LICENSE). It is a list of facts about physical objects, and it is only worth anything if everything can
read it, including software with nothing to do with Rexarr.
