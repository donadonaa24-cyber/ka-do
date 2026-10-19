import { useEffect, useMemo, useState } from 'react';
import { play } from './sound';

// コイントス・サイコロの演出：コインは回転しながら落ちて表か裏、サイコロは転がって出た目で止まる

export interface ChanceRoll {
  kind: 'coin' | 'dice';
  /** コインは 'heads' | 'tails'、サイコロは 1〜6 */
  result: 'heads' | 'tails' | number;
  /** 同じ結果が続いても演出し直すための番号 */
  key: number;
}

/** 結果を決める（記録に残して再生でも同じ結果にする） */
export function randomChance(kind: 'coin' | 'dice'): 'heads' | 'tails' | number {
  const n = new Uint32Array(1);
  try {
    crypto.getRandomValues(n);
  } catch {
    n[0] = Math.floor(Math.random() * 2 ** 32);
  }
  return kind === 'coin' ? (n[0] % 2 === 0 ? 'heads' : 'tails') : (n[0] % 6) + 1;
}

/** サイコロの目を正面に向ける回転（正面1・右3・左4・上2・下5・裏6） */
const FACE: Record<number, [number, number]> = {
  1: [0, 0],
  2: [-90, 0],
  3: [0, -90],
  4: [0, 90],
  5: [90, 0],
  6: [0, 180],
};
const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
const FACE_CLASS: Record<number, string> = { 1: 'f1', 2: 'f2', 3: 'f3', 4: 'f4', 5: 'f5', 6: 'f6' };

const ROLL_MS = 1500;

export function ChanceFx({ roll, onDone }: { roll: ChanceRoll; onDone: () => void }) {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    setLanded(false);
    play(roll.kind);
    const t1 = window.setTimeout(() => {
      setLanded(true);
      play(roll.kind === 'coin' ? 'coinLand' : 'diceLand');
    }, ROLL_MS);
    const t2 = window.setTimeout(onDone, ROLL_MS + 1600);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // 新しい結果の時だけ演出する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.key]);

  // サイコロ：転がり始めの向きはランダム、最後は出た目が正面
  const vars = useMemo(() => {
    if (roll.kind === 'coin')
      return { '--end': `${1800 + (roll.result === 'tails' ? 180 : 0)}deg` } as React.CSSProperties;
    const [ex, ey] = FACE[roll.result as number];
    return {
      '--sx': `${Math.floor(Math.random() * 360)}deg`,
      '--sy': `${Math.floor(Math.random() * 360)}deg`,
      '--ex': `${ex + 720}deg`,
      '--ey': `${ey + 1080}deg`,
    } as React.CSSProperties;
  }, [roll.key, roll.kind, roll.result]);

  const label = roll.kind === 'coin' ? (roll.result === 'heads' ? '表' : '裏') : `${roll.result}の目`;
  return (
    <div
      className="chance-layer"
      onClick={onDone}
      role="dialog"
      aria-label={roll.kind === 'coin' ? 'コイントス' : 'サイコロ'}
    >
      <div className="chance-stage">
        {roll.kind === 'coin' ? (
          <div className="coin-drop">
            <div key={roll.key} className="coin" style={vars}>
              <div className="coin-face heads">表</div>
              <div className="coin-face tails">裏</div>
            </div>
          </div>
        ) : (
          <div key={roll.key} className="dice-roll">
            <div className="dice" style={vars}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <div key={n} className={`dice-face ${FACE_CLASS[n]}`}>
                  {Array.from({ length: 9 }, (_, i) => (
                    <span key={i} className={PIPS[n].includes(i) ? `pip ${n === 1 ? 'red' : ''}` : ''} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className={`chance-result ${landed ? 'show' : ''}`}>{landed ? label : ''}</div>
      </div>
    </div>
  );
}
