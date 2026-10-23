/**
 * What Rexarr writes inside the file, as opposed to on it.
 *
 * Plex and Jellyfin both read the container's title tag, and Jellyfin can be told to prefer it over the name it
 * matched. So whatever goes in there is a name someone may end up reading instead of the episode's real one -
 * which is why "Naruto - S01E01 - disc rip" was wrong: "disc rip" is Rexarr's own note about where the file came
 * from, for the Activity page, and had no business being in the file.
 */
import type { FileMetadataSettings } from '../../../shared/types.js';

/** Rexarr's own provenance, which belongs in the queue and not in the file. */
const INTERNAL = /\s*[·\-–]?\s*(disc rip|cd rip|download|local file|manual)\s*$/i;

/**
 * The title to embed, from what the queue calls the job.
 *
 * A job is titled by its show and subtitled by the episode and where it came from. The episode belongs in the
 * file; where it came from does not.
 */
export function embeddedTitle(title: string, subtitle: string | undefined, mode: FileMetadataSettings['title']): string | undefined {
  if (mode === 'none') return undefined;
  const show = title.trim();
  const sub = (subtitle ?? '').replace(INTERNAL, '').trim();
  if (!show) return sub || undefined;
  // only an episode number earns a place beside the show; "Disc rip · t03.mkv" is a file name, not a title
  if (!/^S\d+E\d+/i.test(sub)) return show;
  return `${show} - ${sub.replace(/\s+·\s+/g, ' - ')}`;
}
