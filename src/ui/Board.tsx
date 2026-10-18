import { getDef, type Ctx } from '../engine/game';
import { linkedMainZones } from '../engine/rules';
import type { GameState, Location, OppPile, PileZone } from '../engine/types';
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
  /** カードのドラッグ開始 */
  dragStart?: (uid: string) => (e: React.PointerEvent) => void;
  /** ドラッグ中に指している落とし先（data-drop の値） */
  dropTarget?: string | null;
  /** 練習中の「次の手」で使うカード・出し先 */
  hintCards?: string[];
  hintZones?: Location[];
  /** チェーンに積まれているカード → チェーン番号 */
  chainOf?: Record<string, number>;
  /** 相手の盤面（練習用）を表示する */
  showOpp?: boolean;
  /** 相手の空いているゾーンを押した（カードを置く） */
  onOppZoneClick?: (loc: Location) => void;
  onOppPileClick?: (zone: OppPile) => void;
}

export function Board({
  state,
  ctx,
  selected,
  picked,
  zoneSelectable,
  onCardClick,
  onZoneClick,
  onPileClick,
  dragStart,
  dropTarget,
  hintCards = [],
  hintZones = [],
  chainOf = {},
  showOpp = false,
  onOppZoneClick,
  onOppPileClick,
}: Props) {
  const isHintZone = (loc: Location) =>
    hintZones.some((z) => z.zone === loc.zone && ('index' in z ? z.index : -1) === ('index' in loc ? loc.index : -1));
  const linked = linkedMainZones(state, (u) => getDef(state, ctx, u));

  const slot = (loc: Location, uid: string | null, label: string, extraCls = '') => {
    const selectable = zoneSelectable(loc);
    const drop = 'index' in loc ? `${loc.zone}:${loc.index}` : loc.zone;
    return (
      <div
        className={`zone ${extraCls} ${selectable ? 'zone-selectable' : ''} ${dropTarget === drop ? 'drop-over' : ''} ${
          isHintZone(loc) ? 'hint-zone' : ''
        } ${uid && hintCards.includes(uid) ? 'hint' : ''}`}
        data-drop={drop}
        onClick={() => (selectable ? onZoneClick(loc) : uid && onCardClick(uid))}
      >
        {uid ? (
          <CardView
            def={getDef(state, ctx, uid)}
            inst={state.cards[uid]}
            selected={selected === uid}
            highlighted={picked.includes(uid)}
            onPointerDown={dragStart?.(uid)}
          />
        ) : (
          <span className="zone-label">{label}</span>
        )}
        {uid && chainOf[uid] ? <span className="chain-badge">C{chainOf[uid]}</span> : null}
      </div>
    );
  };

  const pile = (zone: PileZone, label: string) => {
    const list = state[zone];
    const top = zone === 'gy' || zone === 'banished' ? list[list.length - 1] : undefined;
    return (
      <div
        className={`zone pile ${dropTarget === zone ? 'drop-over' : ''} ${list.some((u) => hintCards.includes(u)) ? 'hint' : ''}`}
        data-drop={zone}
        onClick={() => onPileClick(zone)}
      >
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

  const opp = state.opp;
  /** 相手のゾーン：空いていれば押してカードを置く。相手のカードは効果の対象に選べる */
  const oppSlot = (loc: Location, uid: string | null, label: string, extraCls = '') => (
    <div
      className={`zone opp-zone ${extraCls} ${uid && hintCards.includes(uid) ? 'hint' : ''}`}
      onClick={() => (uid ? onCardClick(uid) : onOppZoneClick?.(loc))}
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
      {uid && chainOf[uid] ? <span className="chain-badge">C{chainOf[uid]}</span> : null}
    </div>
  );
  const oppPile = (zone: OppPile, label: string) => {
    const list = opp?.[zone === 'ogy' ? 'gy' : zone === 'obanished' ? 'banished' : 'hand'] ?? [];
    const top = zone === 'ohand' ? undefined : list[list.length - 1];
    return (
      <div className="zone pile opp-zone" onClick={() => onOppPileClick?.(zone)}>
        {top ? (
          <CardView def={getDef(state, ctx, top)} inst={state.cards[top]} />
        ) : (
          <div className={`card ${zone === 'ohand' && list.length ? 'f-back' : 'empty-pile'}`} />
        )}
        <span className="pile-count">
          {label} {list.length}
        </span>
      </div>
    );
  };
  // 相手から見て左端がM1なので、こちらからは左右反転して並べる
  const mirrored = [4, 3, 2, 1, 0];

  return (
    <div className={`board ${showOpp ? 'with-opp' : ''}`}>
      {showOpp && (
        <>
          {/* 相手の魔法＆罠ゾーン */}
          {oppPile('ohand', '相手手札')}
          {mirrored.map((i) => (
            <div key={`ostz${i}`} className="zone-wrap">
              {oppSlot({ zone: 'ostz', index: i }, opp?.stz[i] ?? null, '相手魔罠')}
            </div>
          ))}
          {oppPile('obanished', '相手除外')}
          {/* 相手のメインモンスターゾーン */}
          {oppPile('ogy', '相手墓地')}
          {mirrored.map((i) => (
            <div key={`omz${i}`} className="zone-wrap">
              {oppSlot({ zone: 'omz', index: i }, opp?.mz[i] ?? null, '相手M', 'mz')}
            </div>
          ))}
          {oppSlot({ zone: 'ofz' }, opp?.fz ?? null, '相手F', 'fz')}
        </>
      )}
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
