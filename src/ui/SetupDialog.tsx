import { useState } from 'react';
import { randomSeed } from '../engine/rng';
import { CARD_DB, DECKS } from '../data';
import type { SessionData } from './session';

interface Props {
  initial: SessionData;
  onStart: (s: SessionData) => void;
  onClose: () => void;
}

export function SetupDialog({ initial, onStart, onClose }: Props) {
  const [deckName, setDeckName] = useState(initial.deckName);
  const [seed, setSeed] = useState(initial.seed);
  const [fixedHand, setFixedHand] = useState<string[]>(initial.fixedHand);
  const [strict, setStrict] = useState(initial.strict);

  const deck = DECKS.find((d) => d.name === deckName) ?? DECKS[0];
  const counts = new Map<string, number>();
  for (const id of deck.main) counts.set(id, (counts.get(id) ?? 0) + 1);
  const picked = (id: string) => fixedHand.filter((x) => x === id).length;

  const add = (id: string) => {
    if (fixedHand.length >= 5 || picked(id) >= (counts.get(id) ?? 0)) return;
    setFixedHand([...fixedHand, id]);
  };
  const remove = (id: string) => {
    const i = fixedHand.indexOf(id);
    if (i >= 0) setFixedHand([...fixedHand.slice(0, i), ...fixedHand.slice(i + 1)]);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新しいゲーム</h2>
        <label className="row">
          デッキ
          <select
            value={deckName}
            onChange={(e) => {
              setDeckName(e.target.value);
              setFixedHand([]);
            }}
          >
            {DECKS.map((d) => (
              <option key={d.name}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="row">
          シード
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
          <button onClick={() => setSeed(randomSeed())}>ランダム</button>
        </label>
        <p className="note">同じシードなら同じ初手・同じデッキ順になります。</p>
        <label className="row">
          <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          ルールチェックを行う（オフにすると自由に動かせます）
        </label>

        <h3>初手指定（{fixedHand.length}/5）</h3>
        <p className="note">選んだカードを必ず初手に入れ、残りはシードに従ってランダムに引きます。</p>
        <div className="hand-picker">
          {[...counts.entries()].map(([id, n]) => (
            <div key={id} className="hand-picker-row">
              <span className="grow">
                {CARD_DB[id]?.name ?? id} <small>×{n}</small>
              </span>
              <button onClick={() => remove(id)} disabled={picked(id) === 0}>
                −
              </button>
              <span className="count">{picked(id)}</span>
              <button onClick={() => add(id)} disabled={fixedHand.length >= 5 || picked(id) >= n}>
                ＋
              </button>
            </div>
          ))}
        </div>

        <div className="row end">
          <button onClick={onClose}>キャンセル</button>
          <button className="primary" onClick={() => onStart({ deckName: deck.name, seed, fixedHand, strict, actions: [] })}>
            開始
          </button>
        </div>
      </div>
    </div>
  );
}
