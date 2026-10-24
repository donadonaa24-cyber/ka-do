import { useEffect, useMemo, useState } from 'react';
import { BUILTIN_DECKS, CARD_DB, EDITABLE_CARDS } from '../data';
import type { CardDef, DeckList } from '../engine/types';
import { isExtraDeckCard } from '../engine/types';
import { type CardFoils, FOIL_STYLES, type FoilStyle } from './cardImages';
import { CardView, statLine } from './CardView';
import { deckProblems, MAX_DECKS, newDeckId, type SavedDeck, uniqueName } from './deckStore';

interface Props {
  decks: SavedDeck[];
  /** 今遊んでいるデッキ名 */
  current: string;
  onSave: (decks: SavedDeck[]) => void;
  onPlay: (deckName: string) => void;
  onClose: () => void;
  /** デッキの表示名（既製のデッキは名前を変えられる） */
  nameOf?: (name: string) => string;
  /** 開いた時に、今遊んでいるデッキ（自分で作ったデッキ）の編集から始める */
  openCurrent?: boolean;
  /** カードの加工（キラ） */
  foils?: CardFoils;
  onFoil?: (id: string, style: FoilStyle | null) => void;
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

export function DeckEditor({
  decks,
  current,
  onSave,
  onPlay,
  onClose,
  nameOf = (n) => n,
  openCurrent = false,
  foils = {},
  onFoil,
}: Props) {
  const [editing, setEditing] = useState<SavedDeck | null>(() => {
    const d = openCurrent ? decks.find((x) => x.name === current) : undefined;
    return d ? { ...d } : null;
  });
  /** 加工の一覧を開いている */
  const [foilOpen, setFoilOpen] = useState(false);
  /** 編集画面のタブ：メイン・EX・サイドの中身と、全カードからの追加 */
  const [tab, setTab] = useState<'main' | 'extra' | 'side' | 'add'>('main');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  /** タップして操作中のカード */
  const [focus, setFocus] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 別のカードを開いたら加工の一覧は閉じる
  useEffect(() => setFoilOpen(false), [focus]);

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
      side: from ? [...(from.side ?? [])] : [],
      updatedAt: new Date().toISOString(),
    });
    setTab(from ? 'main' : 'add');
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

  /** 入れる場所：デッキ（メインかEX）かサイド */
  const keyOf = (id: string, where: 'deck' | 'side') =>
    where === 'side' ? 'side' : isExtraDeckCard(CARD_DB[id]) ? 'extra' : 'main';

  const without = (list: string[], id: string) => {
    const i = list.lastIndexOf(id);
    return i >= 0 ? [...list.slice(0, i), ...list.slice(i + 1)] : list;
  };

  const change = (id: string, delta: 1 | -1, where: 'deck' | 'side' = 'deck') => {
    if (!editing) return;
    const key = keyOf(id, where);
    const list = editing[key] ?? [];
    if (delta > 0) {
      // 同じカードはメイン・EX・サイドの合計で3枚まで
      const sameName = [...editing.main, ...editing.extra, ...(editing.side ?? [])].filter(
        (x) => CARD_DB[x].name === CARD_DB[id].name,
      ).length;
      if (sameName >= 3) return;
      setEditing({ ...editing, [key]: [...list, id] });
    } else {
      setEditing({ ...editing, [key]: without(list, id) });
    }
  };

  /** デッキとサイドの間で1枚入れ替える */
  const move = (id: string, to: 'deck' | 'side') => {
    if (!editing) return;
    const fromKey = keyOf(id, to === 'side' ? 'deck' : 'side');
    const toKey = keyOf(id, to);
    const fromList = editing[fromKey] ?? [];
    if (!fromList.includes(id)) return;
    setEditing({ ...editing, [fromKey]: without(fromList, id), [toKey]: [...(editing[toKey] ?? []), id] });
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
            <strong>{nameOf(d.name)}</strong>
            <span className="meta">
              {custom ? '' : '既製・'}メイン{d.main.length}／EX{d.extra.length}
              {d.side?.length ? `／サイド${d.side.length}` : ''}
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
                    setTab('main');
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
                編集（自分のデッキとして保存）
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
  const side = editing.side ?? [];
  const idsOf = (list: string[]) => [...new Set(sortIds(list))];
  const tabIds =
    tab === 'main'
      ? idsOf(editing.main)
      : tab === 'extra'
        ? idsOf(editing.extra)
        : tab === 'side'
          ? idsOf(side)
          : pool.map((c) => c.id);
  const inDeckOf = (id: string) => countOf(isExtraDeckCard(CARD_DB[id]) ? editing.extra : editing.main, id);
  const inSideOf = (id: string) => countOf(side, id);
  const totalOf = (id: string) =>
    [...editing.main, ...editing.extra, ...side].filter((x) => CARD_DB[x].name === CARD_DB[id].name).length;

  /** カード一覧（画像のマス）。タップすると下に操作ボタンが出る */
  const tile = (id: string) => {
    const def = CARD_DB[id];
    const n = tab === 'side' ? inSideOf(id) : tab === 'add' ? inDeckOf(id) : inDeckOf(id);
    const sideN = inSideOf(id);
    return (
      <button
        key={id}
        className={`deck-tile-card ${focus === id ? 'on' : ''} ${tab === 'add' && n + sideN === 0 ? 'dim' : ''}`}
        onClick={() => setFocus(focus === id ? null : id)}
        aria-label={`${def.name}（${tab === 'side' ? 'サイド' : 'デッキ'}${n}枚）`}
      >
        <CardView def={def} small />
        {def.variant && <span className="tile-variant">{def.variant}</span>}
        {n > 0 && <span className="tile-count">×{n}</span>}
        {tab === 'add' && sideN > 0 && <span className="tile-side">サ{sideN}</span>}
      </button>
    );
  };

  const focusDef = focus ? CARD_DB[focus] : null;
  const actionBar = focus && focusDef && (
    <div className="deck-action">
      <div className="deck-action-head">
        <CardView def={focusDef} small />
        <div className="grow">
          <strong>
            {focusDef.name}
            {focusDef.variant && `（${focusDef.variant}）`}
          </strong>
          <span className="meta">{statLine(focusDef)}</span>
          <span className="meta">
            {isExtraDeckCard(focusDef) ? 'EX' : 'メイン'} {inDeckOf(focus)}枚・サイド {inSideOf(focus)}枚（合計
            {totalOf(focus)}/3）
          </span>
        </div>
        <button onClick={() => setFocus(null)} aria-label="閉じる">
          ✕
        </button>
      </div>
      <div className="deck-action-btns">
        {tab === 'side' ? (
          <>
            <button onClick={() => change(focus, -1, 'side')} disabled={inSideOf(focus) === 0}>
              サイドから1枚抜く
            </button>
            <button onClick={() => change(focus, 1, 'side')} disabled={totalOf(focus) >= 3}>
              サイドに1枚足す
            </button>
            <button className="primary" onClick={() => move(focus, 'deck')} disabled={inSideOf(focus) === 0}>
              1枚デッキへ移す
            </button>
          </>
        ) : tab === 'add' ? (
          <>
            <button className="primary" onClick={() => change(focus, 1, 'deck')} disabled={totalOf(focus) >= 3}>
              {isExtraDeckCard(focusDef) ? 'EX' : 'メイン'}に1枚入れる
            </button>
            <button onClick={() => change(focus, -1, 'deck')} disabled={inDeckOf(focus) === 0}>
              {isExtraDeckCard(focusDef) ? 'EX' : 'メイン'}から1枚抜く
            </button>
            <button onClick={() => change(focus, 1, 'side')} disabled={totalOf(focus) >= 3}>
              サイドに1枚入れる
            </button>
            <button onClick={() => change(focus, -1, 'side')} disabled={inSideOf(focus) === 0}>
              サイドから1枚抜く
            </button>
          </>
        ) : (
          <>
            <button onClick={() => change(focus, -1, 'deck')} disabled={inDeckOf(focus) === 0}>
              1枚抜く
            </button>
            <button onClick={() => change(focus, 1, 'deck')} disabled={totalOf(focus) >= 3}>
              1枚足す
            </button>
            <button className="primary" onClick={() => move(focus, 'side')} disabled={inDeckOf(focus) === 0}>
              1枚サイドへ移す
            </button>
          </>
        )}
      </div>
      {onFoil && (
        <>
          <div className="deck-action-btns">
            <button className={foilOpen ? 'on' : ''} aria-expanded={foilOpen} onClick={() => setFoilOpen(!foilOpen)}>
              加工を変更
              {foils[focus] ? `（${FOIL_STYLES.find((f) => f.id === foils[focus])?.short}）` : ''}
            </button>
          </div>
          {foilOpen && (
            <div className="foil-list" role="listbox" aria-label="加工">
              {[{ id: null, label: 'なし' }, ...FOIL_STYLES].map((f) => (
                <button
                  key={f.id ?? 'none'}
                  className={(foils[focus] ?? null) === f.id ? 'on' : ''}
                  onClick={() => {
                    onFoil(focus, f.id);
                    setFoilOpen(false);
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <p className="deck-action-text">{focusDef.text}</p>
    </div>
  );

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
      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="seg deck-tabs" role="tablist" aria-label="デッキ編集">
        {(
          [
            ['main', `メイン ${editing.main.length}`, editing.main.length < 40 || editing.main.length > 60],
            ['extra', `EX ${editing.extra.length}`, editing.extra.length > 15],
            ['side', `サイド ${side.length}`, side.length > 15],
            ['add', '＋カードを探す', false],
          ] as const
        ).map(([t, label, bad]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`${tab === t ? 'on' : ''} ${bad ? 'bad' : ''}`}
            onClick={() => {
              setTab(t);
              setFocus(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'add' && (
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
        </>
      )}
      <p className="note">
        {tab === 'add'
          ? 'カードをタップすると、メイン（EX）やサイドに入れられます。'
          : 'カードをタップすると、枚数の増減やサイドとの入れ替えができます。'}
      </p>
      <div className="card-grid">
        {tabIds.length ? (
          tabIds.map(tile)
        ) : (
          <p className="note">カードがありません（「＋カードを探す」から入れられます）</p>
        )}
      </div>
      {actionBar}
    </div>
  );
}
