import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { FfmpegCapabilities, Profile } from '@shared/types';
import { AUDIO_ENCODER_INFO, CONTAINER_INFO, LANGUAGES, VIDEO_ENCODER_INFO } from '@shared/presets';
import { api, type PreviewResult } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton } from '../components/Layout';
import { Icon } from '../components/Icons';
import { Modal } from '../components/Modal';

/** fre:ac encoders offered for music profiles (all open source). */
const MUSIC_FORMATS: { encoder: Profile['audio']['encoder']; container: Profile['container']; label: string; help: string }[] = [
  { encoder: 'copy', container: 'flac', label: 'Keep as downloaded (no encode)', help: 'Grabbed albums are only imported into Lidarr.' },
  { encoder: 'flac', container: 'flac', label: 'FLAC (libFLAC)', help: 'Lossless; bit-perfect unless you lower the sample rate or bit depth.' },
  { encoder: 'wavpack', container: 'wv', label: 'WavPack', help: 'Lossless with APEv2 tags.' },
  { encoder: 'ape', container: 'ape', label: "Monkey's Audio", help: 'Lossless, very small, slower to decode.' },
  { encoder: 'libmp3lame', container: 'mp3', label: 'MP3 (LAME)', help: 'Plays everywhere. V0 is transparent for almost everyone.' },
  { encoder: 'libopus', container: 'opus', label: 'Opus (libopus)', help: 'Best lossy quality per bit; 128–160 kbps is transparent for most music. No embedded artwork.' },
  { encoder: 'libvorbis', container: 'ogg', label: 'Ogg Vorbis (libvorbis)', help: 'Open lossy format with artwork support.' },
];

function LangPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  return (
    <div className="chips">
      <span className={`chip${value.length === 0 ? ' on' : ''}`} onClick={() => onChange([])}>
        All
      </span>
      {LANGUAGES.map((l) => (
        <span key={l.code} className={`chip${value.includes(l.code) ? ' on' : ''}`} onClick={() => toggle(l.code)} title={l.code}>
          {l.label}
        </span>
      ))}
    </div>
  );
}

function ProfileEditor({ initial, caps, onClose, onSaved }: { initial: Profile; caps: FfmpegCapabilities | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [p, setP] = useState<Profile>(structuredClone(initial));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewPath, setPreviewPath] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !initial.id;
  const enc = VIDEO_ENCODER_INFO[p.video.encoder];
  const container = CONTAINER_INFO[p.container];
  const upd = <K extends keyof Profile>(k: K, v: Profile[K]) =>
    setP((x) => {
      const next = { ...x, [k]: v };
      // switching to / from music swaps in a sensible container and audio encoder
      if (k === 'mediaType' && v === 'music' && x.mediaType !== 'music') return { ...next, container: 'flac', video: { ...x.video, encoder: 'copy' }, audio: { ...x.audio, encoder: 'flac', compressionLevel: 8, preserveMqa: true, replayGain: true, embedCover: true, languages: [], dropCommentary: false }, subtitles: { ...x.subtitles, mode: 'none' }, output: { ...x.output, renameTokens: false } };
      if (k === 'mediaType' && v !== 'music' && x.mediaType === 'music') return { ...next, container: 'mkv', video: { ...x.video, encoder: 'libx265' }, audio: { ...x.audio, encoder: 'copy' }, subtitles: { ...x.subtitles, mode: 'copy' } };
      return next;
    });
  const isMusic = p.mediaType === 'music';
  const updV = <K extends keyof Profile['video']>(k: K, v: Profile['video'][K]) => setP((x) => ({ ...x, video: { ...x.video, [k]: v } }));
  const updA = <K extends keyof Profile['audio']>(k: K, v: Profile['audio'][K]) => setP((x) => ({ ...x, audio: { ...x.audio, [k]: v } }));
  const updS = <K extends keyof Profile['subtitles']>(k: K, v: Profile['subtitles'][K]) => setP((x) => ({ ...x, subtitles: { ...x.subtitles, [k]: v } }));
  const updO = <K extends keyof Profile['output']>(k: K, v: Profile['output'][K]) => setP((x) => ({ ...x, output: { ...x.output, [k]: v } }));

  const encoderAvailable = (e: string) => !caps || !caps.available || caps.videoEncoders.includes(e as never);
  const audioAvailable = (e: string) => !caps || !caps.available || caps.audioEncoders.includes(e as never);
  const codecOk = enc && (container.videoCodecs[0] === '*' || enc.family === 'copy' || container.videoCodecs.includes(enc.codec));

  const save = async () => {
    if (!p.name.trim()) return toast('warn', 'Give the profile a name');
    setBusy(true);
    try {
      if (isNew) await api.createProfile(p);
      else await api.updateProfile(p.id, p);
      toast('info', `Saved “${p.name}”`);
      onSaved();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.preview({ profile: p, path: previewPath.trim() || undefined }));
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? 'New profile' : `Edit · ${initial.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={doPreview} disabled={busy}>
            <Icon.Terminal /> Preview command
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon.Check />} Save
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label>Name</label>
          <input type="text" value={p.name} onChange={(e) => upd('name', e.target.value)} placeholder="e.g. Anime 1080p x265" />
        </div>
        <div className="field">
          <label>Intended for</label>
          <select value={p.mediaType} onChange={(e) => upd('mediaType', e.target.value as Profile['mediaType'])}>
            <option value="any">Anything</option>
            <option value="movie">Movies</option>
            <option value="tv">TV series</option>
            <option value="anime">Anime</option>
            <option value="music">Music (fre:ac)</option>
          </select>
          <div className="help">Used to sort profiles and pick a default per media type.</div>
        </div>
      </div>
      <div className="field">
        <label>Description</label>
        <input type="text" value={p.description} onChange={(e) => upd('description', e.target.value)} />
      </div>

      {isMusic ? (
        <div className="card">
          <div className="card-h">
            Music · fre:ac
            <span className="spacer" />
            <span className="small dim">open-source encoders only</span>
          </div>
          <div className="card-b">
            <div className="grid-2">
              <div className="field">
                <label>Format</label>
                <select
                  value={p.audio.encoder}
                  onChange={(e) => {
                    const enc = e.target.value as Profile['audio']['encoder'];
                    const container = MUSIC_FORMATS.find((f) => f.encoder === enc)?.container ?? 'flac';
                    setP((x) => ({ ...x, container, audio: { ...x.audio, encoder: enc, bitrate: enc === 'libopus' ? 160 : enc === 'libmp3lame' ? 320 : enc === 'libvorbis' ? 192 : 0, vbrQuality: enc === 'libmp3lame' ? 0 : enc === 'libvorbis' ? 6 : undefined } }));
                  }}
                >
                  {MUSIC_FORMATS.map((f) => (
                    <option key={f.encoder} value={f.encoder}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <div className="help">{MUSIC_FORMATS.find((f) => f.encoder === p.audio.encoder)?.help}</div>
              </div>
              {p.audio.encoder === 'flac' && (
                <div className="field">
                  <label>Compression level</label>
                  <input type="number" min={0} max={8} value={p.audio.compressionLevel ?? 8} onChange={(e) => updA('compressionLevel', Number(e.target.value))} />
                  <div className="help">0 fastest – 8 smallest. Always lossless.</div>
                </div>
              )}
              {p.audio.encoder === 'libmp3lame' && (
                <div className="field">
                  <label>LAME mode</label>
                  <select value={p.audio.vbrQuality === undefined ? 'cbr' : 'vbr'} onChange={(e) => updA('vbrQuality', e.target.value === 'vbr' ? 0 : undefined)}>
                    <option value="vbr">VBR (quality)</option>
                    <option value="cbr">CBR (bitrate)</option>
                  </select>
                </div>
              )}
              {p.audio.encoder === 'libmp3lame' && p.audio.vbrQuality !== undefined && (
                <div className="field">
                  <label>VBR quality</label>
                  <select value={p.audio.vbrQuality} onChange={(e) => updA('vbrQuality', Number(e.target.value))}>
                    {[0, 1, 2, 3, 4, 5].map((q) => (
                      <option key={q} value={q}>
                        V{q}
                        {q === 0 ? ' (~245 kbps)' : q === 2 ? ' (~190 kbps)' : q === 5 ? ' (~130 kbps)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {((p.audio.encoder === 'libmp3lame' && p.audio.vbrQuality === undefined) || p.audio.encoder === 'libopus') && (
                <div className="field">
                  <label>Bitrate (kbps)</label>
                  <input type="number" min={p.audio.encoder === 'libopus' ? 6 : 8} max={p.audio.encoder === 'libopus' ? 510 : 320} value={p.audio.bitrate} onChange={(e) => updA('bitrate', Number(e.target.value))} />
                </div>
              )}
              {p.audio.encoder === 'libvorbis' && (
                <div className="field">
                  <label>Quality</label>
                  <input type="number" min={0} max={10} step={0.5} value={p.audio.vbrQuality ?? 6} onChange={(e) => updA('vbrQuality', Number(e.target.value))} />
                  <div className="help">-q 0–10; 6 ≈ 192 kbps.</div>
                </div>
              )}
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Maximum sample rate</label>
                <select value={p.audio.maxSampleRate ?? 0} onChange={(e) => updA('maxSampleRate', Number(e.target.value))}>
                  <option value={0}>Keep source</option>
                  <option value={44100}>44.1 kHz</option>
                  <option value={48000}>48 kHz</option>
                  <option value={96000}>96 kHz</option>
                </select>
                <div className="help">Higher rates are resampled with soxr.</div>
              </div>
              <div className="field">
                <label>Bit depth</label>
                <select value={p.audio.bitDepth ?? 0} onChange={(e) => updA('bitDepth', Number(e.target.value) as 0 | 16 | 24)} disabled={!['flac', 'wavpack', 'ape'].includes(p.audio.encoder)}>
                  <option value={0}>Keep source</option>
                  <option value={24}>24-bit</option>
                  <option value={16}>16-bit (dithered)</option>
                </select>
              </div>
            </div>
            <label className="check mb">
              <input type="checkbox" checked={p.audio.preserveMqa ?? true} onChange={(e) => updA('preserveMqa', e.target.checked)} /> Keep MQA intact <span className="dim">– MQA files are never resampled or dithered, and lossy formats skip them</span>
            </label>
            <label className="check mb">
              <input type="checkbox" checked={p.audio.replayGain ?? true} onChange={(e) => updA('replayGain', e.target.checked)} /> Write ReplayGain track tags <span className="dim">(FLAC, MP3, Opus)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={p.audio.embedCover ?? true} onChange={(e) => updA('embedCover', e.target.checked)} disabled={p.audio.encoder === 'libopus'} /> Keep embedded cover art
            </label>
          </div>
        </div>
      ) : (
        <>
      <div className="grid-2">
        <div className="card">
          <div className="card-h">Video</div>
          <div className="card-b">
            <div className="field">
              <label>Container</label>
              <select value={p.container} onChange={(e) => upd('container', e.target.value as Profile['container'])}>
                {Object.entries(CONTAINER_INFO).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Video encoder</label>
              <select value={p.video.encoder} onChange={(e) => { const next = e.target.value as Profile['video']['encoder']; const info = VIDEO_ENCODER_INFO[next]; setP((x) => ({ ...x, video: { ...x.video, encoder: next, preset: info.presets.includes(x.video.preset) ? x.video.preset : info.presets[Math.floor(info.presets.length / 2)] ?? '', quality: Math.min(Math.max(x.video.quality, info.qualityRange[0]), info.qualityRange[1] || x.video.quality) } })); }}>
                {Object.entries(VIDEO_ENCODER_INFO).map(([k, v]) => (
                  <option key={k} value={k} disabled={!encoderAvailable(k)}>
                    {v.label}
                    {!encoderAvailable(k) ? ' (not in this ffmpeg)' : ''}
                  </option>
                ))}
              </select>
              {!codecOk && <div className="help" style={{ color: '#ff9c9c' }}>{enc?.codec} is not valid in {p.container}.</div>}
            </div>
            {enc?.family !== 'copy' && (
              <>
                <div className="grid-2">
                  <div className="field">
                    <label>{enc?.qualityLabel ?? 'Quality'}</label>
                    <input type="number" min={enc?.qualityRange[0]} max={enc?.qualityRange[1]} value={p.video.quality} onChange={(e) => updV('quality', Number(e.target.value))} />
                    <div className="help">{enc?.family === 'videotoolbox' ? 'Higher = better quality.' : 'Lower = better quality, bigger file.'}</div>
                  </div>
                  <div className="field">
                    <label>Preset / speed</label>
                    {enc?.presets.length ? (
                      <select value={p.video.preset} onChange={(e) => updV('preset', e.target.value)}>
                        {enc.presets.map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input type="text" value={p.video.preset} disabled placeholder="n/a" />
                    )}
                  </div>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>Pixel format</label>
                    <select value={p.video.pixelFormat} onChange={(e) => updV('pixelFormat', e.target.value as Profile['video']['pixelFormat'])}>
                      <option value="auto">Auto (keep source)</option>
                      <option value="yuv420p">8-bit (yuv420p)</option>
                      <option value="yuv420p10le">10-bit (yuv420p10le)</option>
                      <option value="p010le">10-bit hardware (p010le)</option>
                      <option value="nv12">8-bit hardware (nv12)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Tune</label>
                    <select value={p.video.tune} onChange={(e) => updV('tune', e.target.value as Profile['video']['tune'])} disabled={enc?.family !== 'x264' && enc?.family !== 'x265'}>
                      <option value="none">None</option>
                      <option value="animation">Animation (anime)</option>
                      <option value="film">Film</option>
                      <option value="grain">Grain</option>
                      <option value="fastdecode">Fast decode</option>
                      <option value="zerolatency">Zero latency</option>
                    </select>
                  </div>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label>Max height</label>
                    <select value={p.video.maxHeight} onChange={(e) => updV('maxHeight', Number(e.target.value))}>
                      <option value={0}>Keep source</option>
                      <option value={2160}>2160p</option>
                      <option value={1440}>1440p</option>
                      <option value={1080}>1080p</option>
                      <option value={720}>720p</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Bitrate (kbps, 0 = quality mode)</label>
                    <input type="number" min={0} value={p.video.bitrate} onChange={(e) => updV('bitrate', Number(e.target.value))} />
                  </div>
                </div>
                <label className="check mb">
                  <input type="checkbox" checked={p.video.hdrPassthrough} onChange={(e) => updV('hdrPassthrough', e.target.checked)} /> Keep HDR10 metadata when the source is HDR
                </label>
                <div className="field">
                  <label>Hardware acceleration</label>
                  <select value={p.video.hwMode ?? 'auto'} onChange={(e) => updV('hwMode', e.target.value as 'auto' | 'software')}>
                    <option value="auto">Follow Settings → Transcoding</option>
                    <option value="software">Software only (CPU) – best quality</option>
                  </select>
                  <div className="help">With a hardware method selected in Settings, x264 / x265 / SVT-AV1 profiles use the GPU encoder unless set to software only.</div>
                </div>
                <div className="field">
                  <label>Extra ffmpeg video args</label>
                  <input type="text" className="mono" value={p.video.extraArgs} onChange={(e) => updV('extraArgs', e.target.value)} placeholder="-x265-params aq-mode=3" />
                </div>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="card mb">
            <div className="card-h">Audio</div>
            <div className="card-b">
              <div className="field">
                <label>Audio encoder</label>
                <select value={p.audio.encoder} onChange={(e) => { const next = e.target.value as Profile['audio']['encoder']; setP((x) => ({ ...x, audio: { ...x.audio, encoder: next, bitrate: x.audio.bitrate || AUDIO_ENCODER_INFO[next].defaultBitrate } })); }}>
                  {Object.entries(AUDIO_ENCODER_INFO).map(([k, v]) => (
                    <option key={k} value={k} disabled={!audioAvailable(k)}>
                      {v.label}
                      {!audioAvailable(k) ? ' (not in this ffmpeg)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {p.audio.encoder !== 'copy' && (
                <div className="grid-2">
                  <div className="field">
                    <label>Bitrate per track (kbps)</label>
                    <input type="number" min={0} value={p.audio.bitrate} onChange={(e) => updA('bitrate', Number(e.target.value))} disabled={AUDIO_ENCODER_INFO[p.audio.encoder]?.lossless} />
                  </div>
                  <div className="field">
                    <label>Channels</label>
                    <select value={p.audio.channels} onChange={(e) => updA('channels', Number(e.target.value))}>
                      <option value={0}>Keep source layout</option>
                      <option value={2}>Stereo (downmix)</option>
                      <option value={6}>5.1</option>
                      <option value={8}>7.1</option>
                    </select>
                  </div>
                </div>
              )}
              <div className="field">
                <label>Languages to keep</label>
                <LangPicker value={p.audio.languages} onChange={(v) => updA('languages', v)} />
              </div>
              <label className="check mb">
                <input type="checkbox" checked={p.audio.firstMatchOnly} onChange={(e) => updA('firstMatchOnly', e.target.checked)} /> Only one track per language
              </label>
              <label className="check">
                <input type="checkbox" checked={p.audio.dropCommentary} onChange={(e) => updA('dropCommentary', e.target.checked)} /> Drop commentary tracks
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-h">Subtitles</div>
            <div className="card-b">
              <div className="field">
                <label>Mode</label>
                <select value={p.subtitles.mode} onChange={(e) => updS('mode', e.target.value as Profile['subtitles']['mode'])}>
                  <option value="copy">Copy all matching streams</option>
                  <option value="copy-text">Copy text subtitles only (SRT/ASS)</option>
                  <option value="burn">Burn one track into the video</option>
                  <option value="none">Drop all subtitles</option>
                </select>
                {!container.bitmapSubs && p.subtitles.mode === 'copy' && <div className="help">{p.container.toUpperCase()} cannot hold PGS/VobSub; bitmap subtitles are dropped and text subtitles become {container.textSubs}.</div>}
              </div>
              {(p.subtitles.mode === 'copy' || p.subtitles.mode === 'copy-text') && (
                <div className="field">
                  <label>Languages to keep</label>
                  <LangPicker value={p.subtitles.languages} onChange={(v) => updS('languages', v)} />
                </div>
              )}
              {p.subtitles.mode === 'burn' && (
                <div className="grid-2">
                  <div className="field">
                    <label>Burn language</label>
                    <select value={p.subtitles.burnLanguage} onChange={(e) => updS('burnLanguage', e.target.value)}>
                      <option value="">First subtitle stream</option>
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="check" style={{ marginTop: 24 }}>
                    <input type="checkbox" checked={p.subtitles.burnForcedOnly} onChange={(e) => updS('burnForcedOnly', e.target.checked)} /> Prefer forced track
                  </label>
                </div>
              )}
              {container.attachments && (
                <label className="check">
                  <input type="checkbox" checked={p.subtitles.keepFonts} onChange={(e) => updS('keepFonts', e.target.checked)} /> Keep font attachments (needed for styled anime subs)
                </label>
              )}
            </div>
          </div>
        </div>
      </div>

        </>
      )}

      <div className="card mt">
        <div className="card-h">Output</div>
        <div className="card-b">
          <div className="grid-2">
            <div className="field">
              <label>Output directory</label>
              <input type="text" value={p.output.directory} onChange={(e) => updO('directory', e.target.value)} placeholder="Leave empty to write next to the source" />
            </div>
            <div className="field">
              <label>Filename suffix</label>
              <input type="text" value={p.output.suffix} onChange={(e) => updO('suffix', e.target.value)} placeholder="e.g. -x265" />
            </div>
          </div>
          <label className="check mb">
            <input type="checkbox" checked={p.output.renameTokens !== false} onChange={(e) => updO('renameTokens', e.target.checked)} /> Rename for the encode: <span className="dim">Remux-2160p → Bluray-2160p, AVC → x265, TrueHD 7.1 → Opus 7.1</span>
          </label>
          <div className="help" style={{ margin: '-6px 0 12px 30px' }}>
            Only quality, resolution, codec, audio, HDR and bit-depth tokens already in the name are changed; titles, years and release groups stay. Radarr / Sonarr then report the real quality instead of Remux.
          </div>
          <label className="check mb">
            <input type="checkbox" checked={p.output.cleanMetadata !== false} onChange={(e) => updO('cleanMetadata', e.target.checked)} /> Write clean metadata: <span className="dim">file title, “English · Opus 5.1” track names, default track, no stale source tags</span>
          </label>
          <label className="check mb">
            <input type="checkbox" checked={p.output.replaceOriginal} onChange={(e) => updO('replaceOriginal', e.target.checked)} /> Replace the original remux after a successful encode (deletes the source file)
          </label>
          <label className="check">
            <input type="checkbox" checked={p.output.notifyArr} onChange={(e) => updO('notifyArr', e.target.checked)} /> Ask Radarr / Sonarr to rescan the folder when done
          </label>
        </div>
      </div>

      <div className="card mt">
        <div className="card-h">
          Command preview
          <span className="spacer" />
          <input type="text" style={{ width: 360 }} placeholder="Optional: path to a real file to probe" value={previewPath} onChange={(e) => setPreviewPath(e.target.value)} />
          <button className="btn sm" onClick={doPreview} disabled={busy}>
            Generate
          </button>
        </div>
        {preview && (
          <div className="card-b">
            {preview.sample && <div className="info small">Based on a sample 4K HDR remux with TrueHD 7.1 (eng), DTS-HD 5.1 (jpn), a commentary track, SRT + PGS + ASS subtitles and a font attachment.</div>}
            {preview.warnings.map((w, i) => (
              <div key={i} className="warn small">
                {w}
              </div>
            ))}
            <ul className="small dim" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              {preview.summary.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            {preview.output && (
              <div className="field stack">
                <label>Output file</label>
                <code className="outputName">{preview.output.split('/').pop()}</code>
              </div>
            )}
            <pre className="log">{preview.command}</pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

function blankProfile(): Profile {
  return {
    id: '',
    name: '',
    description: '',
    builtin: false,
    mediaType: 'any',
    container: 'mkv',
    video: { encoder: 'libx265', quality: 20, preset: 'slow', pixelFormat: 'yuv420p10le', tune: 'none', maxHeight: 0, hdrPassthrough: true, bitrate: 0, extraArgs: '', hwMode: 'auto' },
    audio: { encoder: 'copy', bitrate: 0, channels: 0, languages: [], firstMatchOnly: false, dropCommentary: true },
    subtitles: { mode: 'copy', languages: [], burnLanguage: '', burnForcedOnly: false, keepFonts: true },
    output: { directory: '', suffix: '', renameTokens: true, cleanMetadata: true, replaceOriginal: false, notifyArr: true },
    createdAt: '',
    updatedAt: '',
  };
}

export function ProfilesPage() {
  const { profiles, reloadProfiles, toast } = useApp();
  const { id } = useParams();
  const nav = useNavigate();
  const [caps, setCaps] = useState<FfmpegCapabilities | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [filter, setFilter] = useState<'all' | 'movie' | 'tv' | 'anime' | 'music'>('all');

  useEffect(() => {
    api.ffmpeg().then(setCaps).catch(() => {});
  }, []);
  useEffect(() => {
    if (id && profiles.length) {
      const p = profiles.find((x) => x.id === id);
      if (p) setEditing(p.builtin ? { ...structuredClone(p), id: '', name: `${p.name} (copy)`, builtin: false } : p);
    }
  }, [id, profiles]);

  const list = useMemo(() => profiles.filter((p) => filter === 'all' || p.mediaType === filter || (p.mediaType === 'any' && filter !== 'music')), [profiles, filter]);

  const clone = async (p: Profile) => {
    try {
      const c = await api.cloneProfile(p.id);
      await reloadProfiles();
      setEditing(c);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const remove = async (p: Profile) => {
    if (!confirm(`Delete profile “${p.name}”?`)) return;
    try {
      await api.deleteProfile(p.id);
      await reloadProfiles();
      toast('info', 'Profile deleted');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <Page
      title="Profiles"
      toolbarLeft={<ToolbarButton icon={<Icon.Plus />} label="New profile" wide onClick={() => setEditing(blankProfile())} />}
    >
      <div className="filterbar">
        <div className="seg">
          {(['all', 'movie', 'tv', 'anime', 'music'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'movie' ? 'Movies' : f === 'tv' ? 'TV' : f === 'anime' ? 'Anime' : 'Music'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="small dim">Built-in presets are read-only. Clone one to customise it.</span>
      </div>
      <div className="grid-3">
        {list.map((p) => {
          const enc = VIDEO_ENCODER_INFO[p.video.encoder];
          const missing = caps?.available && !caps.videoEncoders.includes(p.video.encoder);
          return (
            <div key={p.id} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="card-h">
                <span className="truncate">{p.name}</span>
                <span className="spacer" />
                {p.builtin ? <span className="badge muted">Preset</span> : <span className="badge green">Custom</span>}
                {p.mediaType !== 'any' && <span className={`badge ${p.mediaType === 'anime' ? 'purple' : p.mediaType === 'music' ? 'green' : 'blue'}`}>{p.mediaType}</span>}
              </div>
              <div className="card-b small" style={{ flex: 1 }}>
                <p className="dim" style={{ marginTop: 0 }}>
                  {p.description || 'No description.'}
                </p>
                {missing && p.mediaType !== 'music' && <div className="warn small">{p.video.encoder} is not available in the detected ffmpeg build.</div>}
                {p.mediaType === 'music' ? (
                  <div className="grid-2" style={{ gap: 8 }}>
                    <div><span className="muted">Format</span><br />{MUSIC_FORMATS.find((f) => f.encoder === p.audio.encoder)?.label ?? p.audio.encoder}</div>
                    <div><span className="muted">Quality</span><br />{p.audio.encoder === 'flac' ? `level ${p.audio.compressionLevel ?? 8}` : p.audio.vbrQuality !== undefined ? (p.audio.encoder === 'libmp3lame' ? `V${p.audio.vbrQuality}` : `q${p.audio.vbrQuality}`) : p.audio.bitrate ? `${p.audio.bitrate} kbps` : '—'}</div>
                    <div><span className="muted">Resolution</span><br />{p.audio.bitDepth ? `${p.audio.bitDepth}-bit` : 'source depth'} · {p.audio.maxSampleRate ? `≤${p.audio.maxSampleRate / 1000} kHz` : 'source rate'}</div>
                    <div><span className="muted">Extras</span><br />{[p.audio.preserveMqa ? 'MQA safe' : '', p.audio.replayGain ? 'ReplayGain' : '', p.audio.embedCover !== false ? 'cover' : ''].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                ) : (
                <div className="grid-2" style={{ gap: 8 }}>
                  <div><span className="muted">Container</span><br />{p.container.toUpperCase()}</div>
                  <div><span className="muted">Video</span><br />{enc?.label.split(' (')[0] ?? p.video.encoder}{enc?.family !== 'copy' ? ` · ${enc?.qualityLabel} ${p.video.quality}` : ''}{p.video.preset ? ` · ${p.video.preset}` : ''}</div>
                  <div><span className="muted">Audio</span><br />{AUDIO_ENCODER_INFO[p.audio.encoder]?.label.split(' (')[0]}{p.audio.bitrate ? ` ${p.audio.bitrate}k` : ''}{p.audio.languages.length ? ` · ${p.audio.languages.join('/')}` : ''}</div>
                  <div><span className="muted">Subtitles</span><br />{p.subtitles.mode}{p.subtitles.keepFonts && p.container === 'mkv' ? ' + fonts' : ''}</div>
                </div>
                )}
                {(p.video.tune !== 'none' || p.video.maxHeight > 0 || p.output.replaceOriginal) && (
                  <div className="chips mt">
                    {p.video.tune !== 'none' && <span className="chip on">tune {p.video.tune}</span>}
                    {p.video.maxHeight > 0 && <span className="chip on">≤{p.video.maxHeight}p</span>}
                    {p.output.replaceOriginal && <span className="chip on">replaces original</span>}
                  </div>
                )}
              </div>
              <div className="modal-f" style={{ padding: '10px 14px', alignItems: 'center' }}>
                {p.builtin ? (
                  <button className="btn sm" onClick={() => clone(p)}>
                    <Icon.Copy /> Clone & edit
                  </button>
                ) : (
                  <>
                    <button className="iconButton danger" onClick={() => remove(p)} title="Delete">
                      <Icon.Trash />
                    </button>
                    <button className="iconButton" onClick={() => clone(p)} title="Clone">
                      <Icon.Copy />
                    </button>
                    <button className="btn sm primary" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editing && (
        <ProfileEditor
          initial={editing}
          caps={caps}
          onClose={() => {
            setEditing(null);
            if (id) nav('/profiles');
          }}
          onSaved={reloadProfiles}
        />
      )}
    </Page>
  );
}
