import { getDef, type Ctx } from '../engine/game';
import { linkedMainZones } from '../engine/rules';
import type { GameState, Location, PileZone } from '../engine/types';
import { CardView } from './CardView';

interface Props {
  state: GameState;
  ctx: Ctx;
  selected: string | null;
  /** 素材などで選択中のカード */
  picked: string[];
  /** クリック可能なゾーン（ゾーン選択中のみ） */
  zoneSelectable: (loc: Location) => boolean;
  onCardClick: (uid: string) => void;
  onZoneClick: (loc: Location) => void;
  onPileClick: (zone: PileZone) => void;
}

export function Board({ state, ctx, selected, picked, zoneSelectable, onCardClick, onZoneClick, onPileClick }: Props) {
  const linked = linkedMainZones(state, (u) => getDef(state, ctx, u));

  const slot = (loc: Location, uid: string | null, label: string, extraCls = '') => {
    const selectable = zoneSelectable(loc);
    return (
      <div
        className={`zone ${extraCls} ${selectable ? 'zone-selectable' : ''}`}
        onClick={() => (selectable ? onZoneClick(loc) : uid && onCardClick(uid))}
      >
        {uid ? (
          <CardView
            def={getDef(state, ctx, uid)}
            inst={state.cards[uid]}
            selected={selected === uid}
            highlighted={picked.includes(uid)}
          />
        ) : (
          <span className="zone-label">{label}</span>
        )}
      </div>
    );
  };

  const pile = (zone: PileZone, label: string) => {
    const list = state[zone];
    const top = zone === 'gy' || zone === 'banished' ? list[list.length - 1] : undefined;
    return (
      <div className="zone pile" onClick={() => onPileClick(zone)}>
        {top ? (
          <CardView def={getDef(state, ctx, top)} inst={state.cards[top]} />
        ) : (
          <div className={`card ${zone === 'deck' || zone === 'extra' ? 'f-back' : 'empty-pile'}`} />
        )}
        <span className="pile-count">
          {label} {list.length}
        </span>
      </div>
    );
  };

  return (
    <div className="board">
      {/* 1段目: EXモンスターゾーン */}
      <div className="zone blank" />
      <div className="zone blank" />
      {slot({ zone: 'emz', index: 0 }, state.emz[0], 'EX', 'emz')}
      <div className="zone blank" />
      {slot({ zone: 'emz', index: 1 }, state.emz[1], 'EX', 'emz')}
      <div className="zone blank" />
      {pile('banished', '除外')}

      {/* 2段目: メインモンスターゾーン */}
      {slot({ zone: 'fz' }, state.fz, 'フィールド', 'fz')}
      {state.mz.map((uid, i) => (
        <div key={`mz${i}`} className="zone-wrap">
          {slot({ zone: 'mz', index: i }, uid, `M${i + 1}`, `mz ${linked.has(i) ? 'linked' : ''}`)}
        </div>
      ))}
      {pile('gy', '墓地')}

      {/* 3段目: 魔法＆罠ゾーン */}
      {pile('extra', 'EX')}
      {state.stz.map((uid, i) => (
        <div key={`stz${i}`} className="zone-wrap">
          {slot({ zone: 'stz', index: i }, uid, i === 0 || i === 4 ? `P/魔罠${i + 1}` : `魔罠${i + 1}`, 'stz')}
        </div>
      ))}
      {pile('deck', 'デッキ')}
    </div>
  );
}
