import { useMemo, useState } from 'react';
import { BUILTIN_DECKS, CARD_DB, EDITABLE_CARDS } from '../data';
import type { CardDef, DeckList } from '../engine/types';
import { isExtraDeckCard } from '../engine/types';
import { CardView, statLine } from './CardView';
import { deckProblems, MAX_DECKS, newDeckId, type SavedDeck, uniqueName } from './deckStore';

interface Props {
  decks: SavedDeck[];
  /** 今遊んでいるデッキ名 */
  current: string;
  onSave: (decks: SavedDeck[]) => void;
  onPlay: (deckName: string) => void;
  onClose: () => void;
}

type Filter = 'all' | 'monster' | 'spell' | 'trap' | 'extra';

const FILTER_LABEL: Record<Filter, string> = {
  all: 'すべて',
  monster: 'モンスター',
  spell: '魔法',
  trap: '罠',
  extra: 'EX',
};

const KIND_ORDER = { monster: 0, spell: 1, trap: 2 };

/** デッキ内の並び：モンスター→魔法→罠、同じ種類は名前順 */
function sortIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const da = CARD_DB[a];
    const db = CARD_DB[b];
    return KIND_ORDER[da.kind] - KIND_ORDER[db.kind] || da.name.localeCompare(db.name, 'ja');
  });
}

function countOf(list: string[], id: string) {
  return list.filter((x) => x === id).length;
}

export function DeckEditor({ decks, current, onSave, onPlay, onClose }: Props) {
  const [editing, setEditing] = useState<SavedDeck | null>(null);
  const [tab, setTab] = useState<'deck' | 'add'>('deck');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const takenNames = (exceptId?: string) => [
    ...BUILTIN_DECKS.map((d) => d.name),
    ...decks.filter((d) => d.id !== exceptId).map((d) => d.name),
  ];

  const startNew = (from?: DeckList) => {
    setEditing({
      id: newDeckId(),
      name: uniqueName(from ? `${from.name}のコピー` : '新しいデッキ', takenNames()),
      main: from ? [...from.main] : [],
      extra: from ? [...from.extra] : [],
      updatedAt: new Date().toISOString(),
    });
    setTab(from ? 'deck' : 'add');
  };

  const save = () => {
    if (!editing) return;
    const deck = {
      ...editing,
      name: uniqueName(editing.name, takenNames(editing.id)),
      updatedAt: new Date().toISOString(),
    };
    const exists = decks.some((d) => d.id === deck.id);
    onSave(exists ? decks.map((d) => (d.id === deck.id ? deck : d)) : [...decks, deck]);
    setEditing(null);
  };

  const change = (id: string, delta: 1 | -1) => {
    if (!editing) return;
    const key = isExtraDeckCard(CARD_DB[id]) ? 'extra' : 'main';
    const list = editing[key];
    if (delta > 0) {
      const sameName = [...editing.main, ...editing.extra].filter((x) => CARD_DB[x].name === CARD_DB[id].name).length;
      if (sameName >= 3) return;
      setEditing({ ...editing, [key]: [...list, id] });
    } else {
      const i = list.lastIndexOf(id);
      if (i >= 0) setEditing({ ...editing, [key]: [...list.slice(0, i), ...list.slice(i + 1)] });
    }
  };

  const pool = useMemo(() => {
    const q = query.trim();
    return EDITABLE_CARDS.filter((c: CardDef) => {
      if (q && !c.name.includes(q) && !c.text.includes(q)) return false;
      if (filter === 'extra') return isExtraDeckCard(c);
      if (filter === 'monster') return c.kind === 'monster' && !isExtraDeckCard(c);
      if (filter === 'spell' || filter === 'trap') return c.kind === filter;
      return true;
    });
  }, [filter, query]);

  // ===== デッキ一覧 =====
  if (!editing) {
    const deckRow = (d: DeckList, custom?: SavedDeck) => {
      const problems = deckProblems(d, CARD_DB);
      return (
        <div key={custom?.id ?? d.name} className={`deck-row ${d.name === current ? 'current' : ''}`}>
          <div className="grow">
            <strong>{d.name}</strong>
            <span className="meta">
              {custom ? '' : '既製・'}メイン{d.main.length}／EX{d.extra.length}
              {d.name === current && '・使用中'}
            </span>
            {problems.length > 0 && <span className="note warn">{problems[0]}</span>}
          </div>
          <div className="btn-row">
            <button className="primary" disabled={problems.length > 0} onClick={() => onPlay(d.name)}>
              遊ぶ
            </button>
            {custom ? (
              <>
                <button
                  onClick={() => {
                    setEditing({ ...custom });
                    setTab('deck');
                  }}
                >
                  編集
                </button>
                {confirmDelete === custom.id ? (
                  <button
                    className="danger"
                    onClick={() => {
                      onSave(decks.filter((x) => x.id !== custom.id));
                      setConfirmDelete(null);
                    }}
                  >
                    本当に削除
                  </button>
                ) : (
                  <button onClick={() => setConfirmDelete(custom.id)}>削除</button>
                )}
              </>
            ) : (
              <button disabled={decks.length >= MAX_DECKS} onClick={() => startNew(d)}>
                コピーして編集
              </button>
            )}
          </div>
        </div>
      );
    };
    return (
      <div className="modal deck-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>デッキ</h2>
          <button onClick={onClose}>閉じる</button>
        </div>
        <p className="note">
          自分のデッキは{MAX_DECKS}個まで保存できます（{decks.length}/{MAX_DECKS}
          ）。デッキはこのブラウザの中に保存されます。
        </p>
        <div className="deck-list">
          {BUILTIN_DECKS.map((d) => deckRow(d))}
          {decks.map((d) => deckRow(d, d))}
        </div>
        <button className="primary" disabled={decks.length >= MAX_DECKS} onClick={() => startNew()}>
          新しいデッキを作る
        </button>
      </div>
    );
  }

  // ===== デッキ編集 =====
  const problems = deckProblems(editing, CARD_DB);
  const deckIds = [...new Set(sortIds(editing.main))];
  const extraIds = [...new Set(sortIds(editing.extra))];
  const row = (id: string) => {
    const def = CARD_DB[id];
    const n = countOf(isExtraDeckCard(def) ? editing.extra : editing.main, id);
    return (
      <div key={id} className="pool-row">
        <CardView def={def} small />
        <div className="grow">
          <span className="pool-name">{def.name}</span>
          <span className="meta">{statLine(def)}</span>
        </div>
        <button onClick={() => change(id, -1)} disabled={n === 0} aria-label={`${def.name}を減らす`}>
          −
        </button>
        <span className="count">{n}</span>
        <button onClick={() => change(id, 1)} aria-label={`${def.name}を増やす`}>
          ＋
        </button>
      </div>
    );
  };

  return (
    <div className="modal deck-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <input
          id="deck-name"
          className="deck-name"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          aria-label="デッキ名"
        />
        <button onClick={() => setEditing(null)}>やめる</button>
        <button className="primary" onClick={save}>
          保存
        </button>
      </div>
      <div className="deck-counts">
        <span className={editing.main.length < 40 || editing.main.length > 60 ? 'bad' : 'good'}>
          メイン {editing.main.length}（40〜60）
        </span>
        <span className={editing.extra.length > 15 ? 'bad' : 'good'}>EX {editing.extra.length}（〜15）</span>
      </div>
      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="seg">
        <button className={tab === 'deck' ? 'on' : ''} onClick={() => setTab('deck')}>
          デッキの中身
        </button>
        <button className={tab === 'add' ? 'on' : ''} onClick={() => setTab('add')}>
          カードを追加
        </button>
      </div>
      {tab === 'deck' ? (
        <div className="pool">
          <strong>メインデッキ</strong>
          {deckIds.length ? deckIds.map(row) : <p className="note">「カードを追加」から入れてください。</p>}
          <strong>EXデッキ</strong>
          {extraIds.length ? extraIds.map(row) : <p className="note">なし</p>}
        </div>
      ) : (
        <>
          <input
            id="card-search"
            value={query}
            placeholder="カード名・テキストで探す"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="seg wrap">
            {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
          <div className="pool">{pool.map((c) => row(c.id))}</div>
        </>
      )}
    </div>
  );
}
