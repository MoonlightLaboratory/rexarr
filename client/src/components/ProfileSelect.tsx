import type { Profile } from '@shared/types';

export function ProfileSelect({ profiles, value, onChange, mediaType }: { profiles: Profile[]; value: string; onChange: (id: string) => void; mediaType?: 'movie' | 'tv' | 'anime' }) {
  const rank = (p: Profile) => (mediaType && p.mediaType === mediaType ? 0 : p.mediaType === 'any' ? 1 : 2);
  const sorted = [...profiles].sort((a, b) => rank(a) - rank(b) || Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  const custom = sorted.filter((p) => !p.builtin);
  const builtin = sorted.filter((p) => p.builtin);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {custom.length > 0 && (
        <optgroup label="My profiles">
          {custom.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Built-in presets">
        {builtin.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
