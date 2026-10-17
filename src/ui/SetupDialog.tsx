import { useState } from 'react';
import { randomSeed } from '../engine/rng';
import { CARD_DB } from '../data';
import type { DeckList } from '../engine/types';
import type { SessionData } from './session';

interface Props {
  initial: SessionData;
  /** 選べるデッキ（既製＋自分で作ったデッキ） */
  decks: DeckList[];
  /** autoSearch: 開始と同時にルートを探す */
  onStart: (s: SessionData, autoSearch: boolean) => void;
  onClose: () => void;
}

type Mode = 'pick' | 'random';

export function SetupDialog({ initial, decks, onStart, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('pick');
  const [deckName, setDeckName] = useState(initial.deckName);
  const [seed, setSeed] = useState(initial.seed);
  const [handSize, setHandSize] = useState<5 | 6>(initial.handSize ?? 5);
  const [fixedHand, setFixedHand] = useState<string[]>(initial.fixedHand.slice(0, initial.handSize ?? 5));
  const [strict, setStrict] = useState(initial.strict);

  const deck = decks.find((d) => d.name === deckName) ?? decks[0];
  const counts = new Map<string, number>();
  for (const id of deck.main) counts.set(id, (counts.get(id) ?? 0) + 1);
  const picked = (id: string) => fixedHand.filter((x) => x === id).length;

  const add = (id: string) => {
    if (fixedHand.length >= handSize || picked(id) >= (counts.get(id) ?? 0)) return;
    setFixedHand([...fixedHand, id]);
  };
  const remove = (id: string) => {
    const i = fixedHand.indexOf(id);
    if (i >= 0) setFixedHand([...fixedHand.slice(0, i), ...fixedHand.slice(i + 1)]);
  };
  const changeSize = (n: 5 | 6) => {
    setHandSize(n);
    setFixedHand(fixedHand.slice(0, n));
  };

  const complete = fixedHand.length === handSize;
  const session = (): SessionData => ({ deckName: deck.name, seed, fixedHand, handSize, strict, actions: [] });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>新しいゲーム</h2>
          <button onClick={onClose}>閉じる</button>
        </div>

        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === 'pick'} className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')}>
            手札を選ぶ
          </button>
          <button role="tab" aria-selected={mode === 'random'} className={mode === 'random' ? 'on' : ''} onClick={() => setMode('random')}>
            ランダムに引く
          </button>
        </div>

        <div className="row">
          <span>枚数</span>
          <div className="seg">
            <button className={handSize === 5 ? 'on' : ''} onClick={() => changeSize(5)}>
              5枚（先攻）
            </button>
            <button className={handSize === 6 ? 'on' : ''} onClick={() => changeSize(6)}>
              6枚（後攻）
            </button>
          </div>
        </div>

        <label className="row">
          デッキ
          <select
            id="deck-select"
            value={deckName}
            onChange={(e) => {
              setDeckName(e.target.value);
              setFixedHand([]);
            }}
          >
            {decks.map((d) => (
              <option key={d.name}>{d.name}</option>
            ))}
          </select>
        </label>

        {mode === 'random' && (
          <>
            <label className="row">
              シード
              <input id="seed" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
              <button onClick={() => setSeed(randomSeed())}>ランダム</button>
            </label>
            <p className="note">同じシードなら同じ初手・同じデッキ順になります。下で選んだカードは必ず初手に入ります。</p>
          </>
        )}

        <div className="hand-preview">
          <strong>
            初手 {fixedHand.length}/{handSize}
          </strong>
          <div className="chips">
            {fixedHand.map((id, i) => (
              <button key={`${id}-${i}`} className="chip" onClick={() => remove(id)} title="外す">
                {CARD_DB[id]?.name ?? id} ×
              </button>
            ))}
            {fixedHand.length === 0 && <span className="note">下のリストから＋で選んでください</span>}
          </div>
        </div>

        <div className="hand-picker">
          {[...counts.entries()].map(([id, n]) => (
            <div key={id} className="hand-picker-row">
              <span className="grow">
                {CARD_DB[id]?.name ?? id} <small>×{n}</small>
              </span>
              <button onClick={() => remove(id)} disabled={picked(id) === 0} aria-label="減らす">
                −
              </button>
              <span className="count">{picked(id)}</span>
              <button onClick={() => add(id)} disabled={fixedHand.length >= handSize || picked(id) >= n} aria-label="増やす">
                ＋
              </button>
            </div>
          ))}
        </div>

        <label className="row">
          <input id="strict" type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          ルールチェックを行う（オフにすると自由に動かせます）
        </label>

        <div className="row end">
          {mode === 'pick' ? (
            <>
              <button disabled={!complete} onClick={() => onStart(session(), false)}>
                開始
              </button>
              <button className="primary" disabled={!complete} onClick={() => onStart(session(), true)}>
                開始して最適ルートを探す
              </button>
            </>
          ) : (
            <>
              <button onClick={() => onStart(session(), false)}>開始</button>
              <button className="primary" onClick={() => onStart(session(), true)}>
                開始してルートを探す
              </button>
            </>
          )}
        </div>
        {mode === 'pick' && !complete && <p className="note">あと{handSize - fixedHand.length}枚選んでください。</p>}
      </div>
    </div>
  );
}
