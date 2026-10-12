import type { Profile, SmartProfile } from '@shared/types';

export function ProfileSelect({ profiles, smart = [], value, onChange, mediaType, suffix }: { profiles: Profile[]; /** Smart profiles, offered first: they pick one of the profiles below once the file can be looked at. */ smart?: SmartProfile[]; value: string; onChange: (id: string) => void; mediaType?: 'movie' | 'tv' | 'anime' | 'music'; /** Extra text per profile id, e.g. an estimated size. */ suffix?: Record<string, string> }) {
  const rank = (p: Profile) => (mediaType && p.mediaType === mediaType ? 0 : p.mediaType === 'any' ? 1 : 2);
  // music profiles only make sense for music, and video profiles never do
  const usable = mediaType ? profiles.filter((p) => (mediaType === 'music') === (p.mediaType === 'music')) : profiles;
  const sorted = [...usable].sort((a, b) => rank(a) - rank(b) || Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  const custom = sorted.filter((p) => !p.builtin);
  const builtin = sorted.filter((p) => p.builtin);
  // a smart profile has nothing to say about music, where there is no video to look at
  const usableSmart = mediaType === 'music' ? [] : smart.filter((p) => !mediaType || p.mediaType === 'any' || p.mediaType === mediaType);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {usableSmart.length > 0 && (
        <optgroup label="Smart profiles (decided per file)">
          {usableSmart.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
      {custom.length > 0 && (
        <optgroup label="My profiles">
          {custom.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {suffix?.[p.id] ? `  —  ${suffix[p.id]}` : ''}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Built-in presets">
        {builtin.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {suffix?.[p.id] ? `  —  ${suffix[p.id]}` : ''}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
