import { useState } from 'react';
import type { Coach } from '../engine/coach';

interface Props {
  coach: Coach;
  done: number;
  /** 次の手を今の盤面で実行できるか */
  canDemo: boolean;
  why: string[];
  onTry: () => void;
  onDemo: () => void;
  onUndo: () => void;
  onShowAll: () => void;
  onRecalc: () => void;
  onRestart: () => void;
  onQuit: () => void;
}

/** 1手ごとの解説。書いてある通りに盤面を操作すると次の手に進む */
export function StepPopup({
  coach,
  done,
  canDemo,
  why,
  onTry,
  onDemo,
  onUndo,
  onShowAll,
  onRecalc,
  onRestart,
  onQuit,
}: Props) {
  const step = coach.steps[done];
  const total = coach.steps.length;
  /** 縮小表示：見出しとボタンだけにして、盤面と手札を広く見せる */
  const [compact, setCompact] = useState(false);
  const toggle = (
    <button className="step-toggle" onClick={() => setCompact((c) => !c)} aria-pressed={compact}>
      {compact ? '詳しく' : '縮小'}
    </button>
  );

  return (
    <div className={`step-popup ${compact ? 'compact' : ''}`} role="dialog" aria-label="次の手の解説">
      <div className="step-dots" aria-hidden="true">
        {coach.steps.map((_, i) => (
          <span key={i} className={i < done ? 'done' : i === done ? 'now' : ''} />
        ))}
      </div>
      {step ? (
        <>
          <div className="step-head">
            <span className="step-count">
              手順 {done + 1}/{total}
            </span>
            <span className="step-route">{coach.title}</span>
            {toggle}
          </div>
          <div className="step-main">{step.text}</div>
          {!compact && step.sub.length > 0 && (
            <ul className="step-sub">
              {step.sub.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {!compact && why.length > 0 && (
            <div className="step-why">
              <strong>なぜ？</strong>
              <ul>
                {why.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          {!canDemo && (
            <p className="note warn">
              今の盤面ではこの手を実行できません。ルートから外れたので、今の盤面から計算し直してください。
            </p>
          )}
          <div className="step-btns">
            {canDemo ? (
              <>
                <button className="primary" onClick={onTry}>
                  盤面で操作する
                </button>
                <button onClick={onDemo}>お手本で実行</button>
              </>
            ) : (
              <button className="primary" onClick={onRecalc}>
                今の盤面から計算し直す
              </button>
            )}
            <button onClick={onUndo}>1手戻す</button>
            <button onClick={onShowAll}>全手順</button>
          </div>
          {!compact && (
            <p className="note">
              光っているカードを使い、金色の枠のゾーンに出します。操作すると自動で次の手に進みます。
            </p>
          )}
        </>
      ) : (
        <>
          <div className="step-head">
            <span className="step-count ok">完成</span>
            <span className="step-route">{coach.title}</span>
            {toggle}
          </div>
          <div className="step-main">この盤面で相手ターンを迎えます</div>
          <div className="step-why" hidden={compact}>
            <strong>相手ターンの動き方</strong>
            <ul>
              {coach.summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
          <div className="step-btns">
            <button className="primary" onClick={onRestart}>
              同じ初手でもう一度
            </button>
            <button onClick={onShowAll}>全手順</button>
            <button onClick={onQuit}>閉じる</button>
          </div>
        </>
      )}
    </div>
  );
}
