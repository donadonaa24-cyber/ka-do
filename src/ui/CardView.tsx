import { MARKER_ARROW } from '../engine/rules';
import type { CardDef, CardInstance } from '../engine/types';

export function frameClass(def: CardDef): string {
  if (def.kind === 'spell') return 'f-spell';
  if (def.kind === 'trap') return 'f-trap';
  return `f-${def.frame ?? 'effect'}`;
}

export function statLine(def: CardDef): string {
  if (def.kind !== 'monster') {
    const t = def.kind === 'spell' ? def.spellType : def.trapType;
    const label: Record<string, string> = {
      normal: '通常',
      quick: '速攻',
      continuous: '永続',
      equip: '装備',
      field: 'フィールド',
      ritual: '儀式',
      counter: 'カウンター',
    };
    return `${label[t ?? 'normal']}${def.kind === 'spell' ? '魔法' : '罠'}`;
  }
  const lv =
    def.frame === 'link' ? `LINK-${def.link}` : def.frame === 'xyz' ? `☆${def.rank}` : `★${def.level ?? '?'}`;
  return def.frame === 'link' ? `${lv} ${def.atk ?? '?'}` : `${lv} ${def.atk ?? '?'}/${def.def ?? '?'}`;
}

interface Props {
  def: CardDef;
  inst?: CardInstance;
  /** 自分だけが見える裏側カード（手札・セット）は半透明で表示する */
  showFaceDown?: boolean;
  selected?: boolean;
  highlighted?: boolean;
  onClick?: () => void;
  small?: boolean;
}

export function CardView({ def, inst, showFaceDown = true, selected, highlighted, onClick, small }: Props) {
  const faceDown = inst ? !inst.faceUp : false;
  const isDef = inst?.position === 'def';
  const cls = [
    'card',
    faceDown && !showFaceDown ? 'f-back' : frameClass(def),
    faceDown ? 'face-down' : '',
    isDef ? 'def-pos' : '',
    selected ? 'selected' : '',
    highlighted ? 'highlighted' : '',
    inst?.pendingResolve ? 'pending' : '',
    small ? 'small' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (faceDown && !showFaceDown) {
    return <div className={cls} onClick={onClick} />;
  }
  return (
    <div className={cls} onClick={onClick} title={`${def.name}\n${def.text}`}>
      <div className="card-name">{def.name}</div>
      <div className="card-stat">{statLine(def)}</div>
      {def.tuner && <div className="card-tag">チューナー</div>}
      {def.frame === 'link' && def.linkMarkers && (
        <div className="card-markers">{def.linkMarkers.map((m) => MARKER_ARROW[m]).join('')}</div>
      )}
      {inst && inst.overlay.length > 0 && <div className="card-overlay">素材{inst.overlay.length}</div>}
      {faceDown && <div className="card-tag">裏側</div>}
    </div>
  );
}
