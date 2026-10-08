import { useEffect, useState } from 'react';
import type { ExpectedDisc, Settings } from '@shared/types';
import { REPO_URL } from '@shared/version';
import { withBase } from '../base';
import { api, fmtAge } from '../api';
import { useApp } from '../App';
import { Page, ToolbarButton } from '../components/Layout';
import { LoadingIndicator } from '../components/Labels';
import { Icon } from '../components/Icons';

/**
 * Beta features, off until they are switched on. Each one says what it is for, what it is not yet, and where to
 * say it is wrong.
 */
export function ExperimentsPage() {
  const { toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [expected, setExpected] = useState<ExpectedDisc[] | null>(null);
  const load = () => api.settings().then((v) => (setS(v), setSaved(v)));
  useEffect(() => {
    load().catch((e) => toast('error', (e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const barcodeOn = saved?.experiments?.barcode === true;
  useEffect(() => {
    if (!barcodeOn) return setExpected(null);
    api.expectedDiscs().then(setExpected).catch(() => setExpected([]));
  }, [barcodeOn]);
  const dirty = Boolean(s && saved && JSON.stringify(s.experiments) !== JSON.stringify(saved.experiments));
  const save = async () => {
    if (!s) return;
    try {
      const v = await api.saveSettings(s);
      setS(v);
      setSaved(v);
      toast('info', 'Saved');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const set = (patch: Partial<NonNullable<Settings['experiments']>>) => s && setS({ ...s, experiments: { ...s.experiments, ...patch } });
  const forget = async (id: string) => {
    await api.forgetExpectedDisc(id).catch((e) => toast('error', (e as Error).message));
    setExpected((list) => (list ?? []).filter((e) => e.id !== id));
  };
  return (
    <Page
      title="Experiments"
      toolbarLeft={<ToolbarButton icon={<Icon.Save />} label={dirty ? 'Save' : 'No Changes'} onClick={save} disabled={!dirty} selected={dirty} />}
      narrow
    >
      {!s ? (
        <LoadingIndicator />
      ) : (
        <>
          <div className="card mb">
            <div className="card-b">
              <p className="small dim" style={{ marginTop: 0 }}>
                Features that are finished enough to try and not finished enough to turn on for everyone. They can
                change or disappear in the next release, and they are the most likely part of Rexarr to be wrong –
                if one misbehaves, <a href={`${REPO_URL}/issues/new?template=bug_report.yml`} target="_blank" rel="noreferrer">tell us what happened</a>{' '}
                or <a href={`${REPO_URL}/discussions/categories/ideas`} target="_blank" rel="noreferrer">talk it through in Discussions</a>.
              </p>
            </div>
          </div>

          <div className="card mb">
            <div className="card-h">
              <label className="check">
                <input type="checkbox" checked={s.experiments?.barcode === true} onChange={(e) => set({ barcode: e.target.checked })} /> Barcode scanning
              </label>
              <span className="spacer" />
              <span className="small dim">beta</span>
            </div>
            <div className="card-b">
              <p className="small dim" style={{ marginTop: 0 }}>
                Scan the barcode on a disc case with your phone and Rexarr works out what it is, adds it to Radarr /
                Sonarr if it is not there yet, and keeps it on a list of discs it expects – so the title is ready
                before the disc goes in the drive. Numbers are looked up at MusicBrainz (music) and UPCitemdb
                (everything else, 100 lookups a day); neither needs an account, and both can simply not know a disc.
              </p>
              {!barcodeOn ? (
                <div className="help">Turn it on and save to get the phone link and its QR code.</div>
              ) : (
                <>
                  <div className="subhead">On your phone</div>
                  <div className="inline" style={{ alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
                    <img src={withBase('/api/scan/qr.svg')} alt="QR code for the scanning page" width={168} height={168} style={{ background: '#fff', padding: 8, borderRadius: 4 }} />
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <div className="help" style={{ marginTop: 0 }}>
                        Point the phone's camera at the code to open Rexarr's scanning page. It is the same Rexarr –
                        the phone has to be able to reach this address, and the code carries your API key when
                        authentication is on, so treat it like a password.
                      </div>
                      <div className="help">
                        <strong>Cameras need HTTPS.</strong> Browsers only give a page the camera over https:// or on
                        localhost, so over plain http on your network the page will ask you to type the number in
                        instead. Turn on SSL under <a href={withBase('/settings/general')}>Settings → General → Host</a>,
                        or put Rexarr behind a proxy that has a certificate.
                      </div>
                      <a className="btn sm mt" href={withBase('/scan')} target="_blank" rel="noreferrer">
                        <Icon.ExternalLink /> Open the scanning page here
                      </a>
                    </div>
                  </div>

                  <div className="subhead row">
                    Discs it is expecting
                    <span className="spacer" />
                    <span className="small dim">{expected?.length ?? 0}</span>
                  </div>
                  {!expected?.length ? (
                    <div className="help">Nothing scanned yet.</div>
                  ) : (
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Title</th>
                            <th>Barcode</th>
                            <th>Scanned</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {expected.map((e) => (
                            <tr key={e.id}>
                              <td>
                                {e.title}
                                {e.year ? <span className="dim"> ({e.year})</span> : null}
                                {e.seasonNumber ? <span className="dim"> · season {e.seasonNumber}</span> : null}
                                <span className={`badge sm ${e.arrId ? 'green' : ''}`}>{e.arrId ? 'in library' : e.kind}</span>
                              </td>
                              <td className="mono small">{e.code}</td>
                              <td className="dim small">{fmtAge(e.addedAt)}</td>
                              <td className="num">
                                <button className="iconButton danger" title="Forget this disc" onClick={() => forget(e.id)}>
                                  <Icon.X />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="card mb">
            <div className="card-h">
              <label className="check">
                <input type="checkbox" checked={s.experiments?.wanted === true} onChange={(e) => set({ wanted: e.target.checked })} /> Ripping to-do list
              </label>
              <span className="spacer" />
              <span className="small dim">beta</span>
            </div>
            <div className="card-b">
              <p className="small dim" style={{ marginTop: 0 }}>
                Radarr and Sonarr already keep a list of what they would like a better copy of – their <em>Cutoff
                Unmet</em> pages – and most of it is waiting for a download that may never come while the better
                copy sits on a shelf in the next room. With this on, the <a href={withBase('/discs')}>Discs</a> page
                shows that list the other way round: what is still low quality, which kind of disc would actually
                improve it, and whether you have already scanned that disc's barcode.
              </p>
              <div className="help">
                A 1080p remux is not improved by a Blu-ray, so those only appear when a UHD disc would help, and
                anything already at 2160p remux is left out entirely.
              </div>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
