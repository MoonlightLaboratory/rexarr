# Adding a disc

You need the disc and a few minutes. There is no account, no API key and nothing to install.

## The short version

Rexarr will offer to do this for you after you correct a disc's episode numbers. If you would rather do it by
hand, or you do not use Rexarr, read on.

## 1. Read the disc

Scan it with whatever you use. You want, in the order the disc lists them:

- each title's **key** — the playlist file it comes from (`00001.mpls`), or its index as a number when the disc
  gives no playlist name, which is usually the case on a DVD
- each title's **duration in whole seconds**
- the **volume label**, exactly as the drive reports it
- what each title **is** — an episode, a season 0 special, an extra, or the "play all" compilation

## 2. Work out the fingerprint

```bash
node scripts/fingerprint.mjs "SWORD_ART_ONLINE_2_P4" 0=1417 1=1416 2=1419 3=1418 4=1417
# 63f07bfa4a431fd1
```

[FINGERPRINT.md](FINGERPRINT.md) explains what it does. The entry is named after it and lives in the directory
named after its first two characters:

```
discs/63/63f07bfa4a431fd1.json
```

## 3. Write the entry

Copy one that is already there. `titles` maps each key to what it is:

| | |
| --- | --- |
| `S02E20` | episode 20 of season 2 |
| `S00E12` | a special, as the catalogues file it — a recap numbered 14.5 is usually one of these |
| `S01E04-E05` | one title holding two episodes |
| `extra`, `extra:op`, `extra:ed` | kept beside the show, not imported as an episode |
| `playall` | the compilation of the others. Never ripped |
| `skip` | there, and not worth having |

Set `status` to `unverified` and `confirmations` to 1. Somebody else's matching submission is what makes it
`verified`; you do not mark your own entry verified.

## 4. Check it

```bash
node scripts/validate.mjs
```

No install. It recomputes every fingerprint rather than believing it — a typo there is a disc that is never
found, or worse, one that is found and is not the disc you have — and it rewrites `index.json`. Commit that too.

## 5. Open a pull request

Say which disc you have and how you know. *"I own it and watched the first minute of each title"* is the best
reason there is.

## If you know the answer but not the disc

If you know a disc's episodes but do not have it to hand, it cannot be fingerprinted, and without a fingerprint
nothing can match it. Put it in `pending/` with `"status": "pending"` and no fingerprint. It will not be applied
to anyone's rip; it is a note for whoever owns that disc, and a prompt for them to finish it.

## What not to add

**Arithmetic.** If you worked out that disc 3 must be episodes 15–19 because discs 1 and 2 held seven each, that
is a guess — and guessing is what software already does, badly, which is the reason this exists. An entry you are
unsure of is worse than no entry, because it will be applied silently and believed.

Leave it out. Someone who owns the disc will add it.
