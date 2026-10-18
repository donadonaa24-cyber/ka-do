import { useMemo, useState } from 'react';
import { CARD_DB, EDITABLE_CARDS } from '../data';
import type { DeckList } from '../engine/types';
import { CardView } from './CardView';
import { type CardImages, matchCard, normalizeName } from './cardImages';

interface Props {
  /** 自分で設定した画像 */
  images: CardImages;
  /** 表示している画像（埋め込みの画像＋自分で設定した画像） */
  shown: CardImages;
  builtin: CardImages;
  decks: DeckList[];
  current: string;
  onSet: (cardId: string, file: File) => Promise<boolean>;
  onClear: (cardId: string) => void;
  onClose: () => void;
}

const ALL = '__all__';

/** カード画像の設定：デッキごと・全カードから選び、1枚ずつかまとめて読み込む */
export function ImageSettings({ images, shown, builtin, decks, current, onSet, onClear, onClose }: Props) {
  // 最初は実装されている全カードを表示する（デッキのタブは絞り込み用）
  const [tab, setTab] = useState(ALL);
  void current;
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [report, setReport] = useState<{ ok: string[]; ng: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const bulk = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const ok: string[] = [];
    const ng: string[] = [];
    for (const f of Array.from(files)) {
      const id = matchCard(f.name);
      if (id && (await onSet(id, f))) ok.push(`${f.name} → ${CARD_DB[id].name}`);
      else ng.push(f.name);
    }
    setReport({ ok, ng });
    setBusy(false);
  };

  const all = tab === ALL;
  /** タブの中の全カード（検索・未設定の絞り込み前） */
  const tabIds = useMemo(() => {
    const deck = decks.find((d) => d.name === tab);
    return deck ? [...new Set([...deck.main, ...deck.extra, ...(deck.side ?? [])])] : EDITABLE_CARDS.map((c) => c.id);
  }, [decks, tab]);
  const setCount = tabIds.filter((id) => shown[id]).length;
  const ids = useMemo(() => {
    const q = normalizeName(query);
    return tabIds.filter(
      (id) => CARD_DB[id] && (!q || normalizeName(CARD_DB[id].name).includes(q)) && (!onlyMissing || !shown[id]),
    );
  }, [tabIds, query, onlyMissing, shown]);

  return (
    <div className="modal route-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h2>カード画像の設定</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <p className="note">
        画像はカードごとに保存され、どのデッキで使っても同じ画像が表示されます（このブラウザの中にだけ保存）。
      </p>

      <div className="seg wrap" role="tablist" aria-label="表示するカード">
        <button role="tab" aria-selected={all} className={all ? 'on' : ''} onClick={() => setTab(ALL)}>
          すべてのカード
        </button>
        {decks.map((d) => (
          <button
            key={d.name}
            role="tab"
            aria-selected={tab === d.name}
            className={tab === d.name ? 'on' : ''}
            onClick={() => setTab(d.name)}
          >
            {d.name}
          </button>
        ))}
      </div>

      <div className="img-tools">
        <input
          type="search"
          placeholder="カード名で探す"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="カード名で探す"
        />
        <label className="toggle">
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          未設定だけ
        </label>
      </div>

      <label className={`file-btn wide-btn ${busy ? 'disabled' : ''}`}>
        {busy ? '読み込み中…' : 'まとめて読み込む（ファイル名のカード名で自動で割り当て）'}
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          onChange={(e) => {
            void bulk(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {report && (
        <div className="img-report">
          <strong>
            {report.ok.length}枚を設定しました
            {report.ng.length ? `・${report.ng.length}枚は割り当てできませんでした` : ''}
          </strong>
          {report.ng.length > 0 && (
            <p className="note warn">
              カード名が分からなかったファイル：{report.ng.join('、')}
              （ファイル名をカード名にするか、下の一覧から1枚ずつ選んでください）
            </p>
          )}
          <button onClick={() => setReport(null)}>閉じる</button>
        </div>
      )}

      <p className="meta">
        {all ? '実装されている全カード' : tab}：設定済み {setCount}/{tabIds.length}（表示 {ids.length}枚）
      </p>
      <div className="img-settings">
        {ids.map((id) => (
          <div key={id} className="img-item">
            <CardView def={CARD_DB[id]} small />
            <div className="grow">
              <span>{CARD_DB[id].name}</span>
              <label className="file-btn small">
                {shown[id] ? '変更' : '画像を選ぶ'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onSet(id, f);
                    e.target.value = '';
                  }}
                />
              </label>
              {images[id] && <button onClick={() => onClear(id)}>{builtin[id] ? '最初に戻す' : '外す'}</button>}
            </div>
          </div>
        ))}
        {ids.length === 0 && <p className="note">該当するカードがありません</p>}
      </div>
    </div>
  );
}
