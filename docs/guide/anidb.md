# AniDB for anime

Enable **Settings → Metadata → AniDB for anime**. Rexarr downloads AniDB's title dump and the
[Anime-Lists](https://github.com/Anime-Lists/anime-lists) mapping (AniDB ↔ TVDB / TMDB / IMDb) — about 20 MB, cached
for a week, no API key and no account. With it:

- **Anime movies are recognised** in Radarr (which has no anime type): an *Anime* filter and badge on Movies, and
  the anime profile is picked by default when transcoding them.
- **Series** get their AniDB ids, romaji and kanji titles; the *Anime* filter uses AniDB as well as Sonarr's series
  type, and both libraries can be sorted by **romaji title**.
- **Disc identification** searches AniDB first, so a Japanese or romaji disc label
  (`KEKKON_SURUTTE_HONTOU_DESUKA_D1`) resolves through the mapping to the right Sonarr series or Radarr movie, marks
  it anime and turns on absolute numbering. See [Disc ripping](disc-ripping.md#identifying-the-disc).
- AniDB links appear in the detail headers.

The data is refreshed by the **Refresh AniDB data** task (weekly) and can be refreshed by hand on the Settings page.
API: `GET /api/anidb/status`, `POST /api/anidb/refresh`, `GET /api/anidb/search?q=`.
