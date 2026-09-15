rexarr – remux-first transcoding for the *arr stack
Copyright 2026 MoonlightLaboratory and rexarr contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

---

Third-party software and services

rexarr runs, but does not include, FFmpeg, fre:ac and MakeMKV; each is covered by its own license (MakeMKV's
`makemkvcon` is not redistributable, which is why the default Docker image cannot rip discs). It talks to
Radarr, Sonarr, Lidarr, Prowlarr and slskd over their APIs, and to TMDb, MusicBrainz, Cover Art Archive and the
Anime-Lists AniDB mapping for metadata; their data remains under their own terms. Dependencies installed by npm
keep their own licenses (see each package in `node_modules`).

rexarr is an independent project and is not affiliated with or endorsed by any of these projects. Sonarr, Radarr,
Lidarr and Prowlarr are trademarks of their respective owners; the *arr style of the interface is rexarr's own
implementation.
