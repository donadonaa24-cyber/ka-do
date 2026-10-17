import type { Attribute, CardDef, CardKind, GameState, MonsterFrame, SpellType, TrapType } from './types';

/** カードの条件（JSONで保存できる形） */
export interface CardFilter {
  kind?: CardKind[];
  frame?: MonsterFrame[];
  spellType?: SpellType[];
  trapType?: TrapType[];
  /** カテゴリ（例: 「トゥーン」カード） */
  archetype?: string;
  /** トゥーンモンスター（トゥーン・ワールドの有無を考慮） */
  toonMonster?: boolean;
  /** カード名が記されている（テキストに「名前」を含む、またはその名前のカード） */
  mentions?: string;
  name?: string[];
  excludeName?: string[];
  attribute?: Attribute[];
  race?: string[];
  minLevel?: number;
  maxLevel?: number;
  cannotNormalSummon?: boolean;
  /** 攻撃力か守備力がこの値 */
  atkOrDef?: number;
  /** いずれかを満たす */
  any?: CardFilter[];
}

export function hasToonWorld(state: GameState, getDef: (uid: string) => CardDef): boolean {
  return !!state.fz && state.cards[state.fz].faceUp && !!getDef(state.fz).treatedAsToonWorld;
}

export function isToonMonster(def: CardDef, toonWorld: boolean): boolean {
  return def.kind === 'monster' && (!!def.toon || (!!def.toonWithWorld && toonWorld));
}

/** 「〇〇」のカード名が記されている */
export function mentionsName(def: CardDef, name: string): boolean {
  return def.name === name || def.treatedAsName === name || def.text.includes(`「${name}」`);
}

export function matchesFilter(def: CardDef, f: CardFilter, toonWorld: boolean): boolean {
  if (f.kind && !f.kind.includes(def.kind)) return false;
  if (f.frame && !(def.frame && f.frame.includes(def.frame))) return false;
  if (f.spellType && !(def.spellType && f.spellType.includes(def.spellType))) return false;
  if (f.trapType && !(def.trapType && f.trapType.includes(def.trapType))) return false;
  if (f.archetype && !def.archetypes?.includes(f.archetype)) return false;
  if (f.toonMonster !== undefined && isToonMonster(def, toonWorld) !== f.toonMonster) return false;
  if (f.mentions && !mentionsName(def, f.mentions)) return false;
  if (f.name && !f.name.includes(def.name) && !(def.treatedAsName && f.name.includes(def.treatedAsName))) return false;
  if (f.excludeName?.includes(def.name)) return false;
  if (f.attribute && !(def.attribute && f.attribute.includes(def.attribute))) return false;
  if (f.race && !(def.race && f.race.includes(def.race))) return false;
  if (f.minLevel !== undefined && !((def.level ?? -1) >= f.minLevel)) return false;
  if (f.maxLevel !== undefined && !(def.level !== undefined && def.level <= f.maxLevel)) return false;
  if (f.cannotNormalSummon !== undefined && !!def.cannotNormalSummon !== f.cannotNormalSummon) return false;
  if (f.atkOrDef !== undefined && def.atk !== f.atkOrDef && def.def !== f.atkOrDef) return false;
  if (f.any && !f.any.some((sub) => matchesFilter(def, sub, toonWorld))) return false;
  return true;
}
