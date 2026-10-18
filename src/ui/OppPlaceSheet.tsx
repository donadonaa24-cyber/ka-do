import { useMemo, useState } from 'react';
import { EDITABLE_CARDS, OPP_GENERIC_CARDS } from '../data';
import type { Action } from '../engine/game';
import { type CardDef, isExtraDeckCard, type Location } from '../engine/types';
import { CardView } from './CardView';
import { normalizeName } from './cardImages';

interface Props {
  to: Location;
  onPlace: (a: Action) => void;
  onClose: () => void;
}

/** 練習用：相手の空いているゾーンにカードを置く（名前の決まっていないカードか、実装済みのカードから選ぶ） */
export function OppPlaceSheet({ to, onPlace, onClose }: Props) {
  const monster = to.zone === 'omz';
  const field = to.zone === 'ofz';
  const [faceUp, setFaceUp] = useState(true);
  const [position, setPosition] = useState<'atk' | 'def'>('atk');
  const [query, setQuery] = useState('');

  const fits = (d: CardDef) =>
    monster ? d.kind === 'monster' : field ? d.spellType === 'field' : d.kind !== 'monster' && d.spellType !== 'field';
  const generic = OPP_GENERIC_CARDS.filter(fits);
  const found = useMemo(() => {
    const q = normalizeName(query);
    if (!q) return [];
    const seen = new Set<string>();
    return EDITABLE_CARDS.filter((d) => {
      if (!fits(d) || seen.has(d.name) || !normalizeName(d.name).includes(q)) return false;
      seen.add(d.name);
      return true;
    }).slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, to.zone]);

  const place = (d: CardDef) => {
    // 裏側で置けるのはメインデッキのカードだけ（EXのモンスターは表側）
    const up = faceUp || (monster && isExtraDeckCard(d));
    onPlace({
      type: 'OPP_PLACE',
      defId: d.id,
      to: to as Extract<Action, { type: 'OPP_PLACE' }>['to'],
      faceUp: up,
      position: monster ? (up ? position : 'def') : undefined,
    });
  };

  const zoneName = monster ? 'モンスターゾーン' : field ? 'フィールドゾーン' : '魔法＆罠ゾーン';
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet opp-place" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>相手の{zoneName}に置く</h2>
          <button onClick={onClose}>閉じる</button>
        </div>
        <div className="seg" role="group" aria-label="表裏">
          <button className={faceUp ? 'on' : ''} aria-pressed={faceUp} onClick={() => setFaceUp(true)}>
            表側
          </button>
          <button className={!faceUp ? 'on' : ''} aria-pressed={!faceUp} onClick={() => setFaceUp(false)}>
            {monster ? '裏側守備' : 'セット（裏側）'}
          </button>
        </div>
        {monster && faceUp && (
          <div className="seg" role="group" aria-label="表示形式">
            <button className={position === 'atk' ? 'on' : ''} onClick={() => setPosition('atk')}>
              攻撃表示
            </button>
            <button className={position === 'def' ? 'on' : ''} onClick={() => setPosition('def')}>
              守備表示
            </button>
          </div>
        )}
        <div className="opp-generic">
          {generic.map((d) => (
            <button key={d.id} className="primary" onClick={() => place(d)}>
              {d.name}を置く
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="実装済みのカードから探す（例：うらら）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="カード名で探す"
        />
        <div className="opp-found">
          {found.map((d) => (
            <button key={d.id} className="opp-found-item" onClick={() => place(d)}>
              <CardView def={d} small />
              <span>{d.name}</span>
            </button>
          ))}
          {query && found.length === 0 && <p className="note">該当するカードがありません</p>}
        </div>
      </div>
    </div>
  );
}
