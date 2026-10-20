import { useMemo, useState } from 'react';
import { BUILTIN_BACK, buildBackup, restoreBackup, saveBackupFile } from './backup';
import { BUILTIN_IMAGES } from './cardImages';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** データの書き出し・読み込み（別のページ・別の端末へ引っ越す） */
export function BackupPanel({ onClose, onError }: { onClose: () => void; onError: (msg: string) => void }) {
  const builtinCount = Object.keys(BUILTIN_IMAGES).length + (BUILTIN_BACK ? 1 : 0);
  const [withBuiltin, setWithBuiltin] = useState(builtinCount > 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 読み込む前の確認（ファイルの中身） */
  const [pendingFile, setPendingFile] = useState<{ name: string; text: string } | null>(null);
  const preview = useMemo(() => buildBackup(withBuiltin, BUILTIN_IMAGES).summary, [withBuiltin]);

  const exportData = async () => {
    setBusy(true);
    setMessage(null);
    const { json } = buildBackup(withBuiltin, BUILTIN_IMAGES);
    const r = await saveBackupFile(json);
    setBusy(false);
    if (r === 'saved') setMessage('書き出しました。引っ越し先のページで「読み込む」からこのファイルを選んでください。');
    else if (r === 'declined') setMessage('保存をやめました。');
    else onError('ファイルを保存できませんでした');
  };

  const importData = () => {
    if (!pendingFile) return;
    const r = restoreBackup(pendingFile.text);
    setPendingFile(null);
    if (typeof r === 'string') {
      onError(r);
      return;
    }
    if (r.failed.length) {
      onError(
        `${r.failed.length}件はブラウザの保存容量が足りず読み込めませんでした（画像を減らすと入ります）。それ以外は読み込みました`,
      );
    }
    // 読み込んだデータで画面を作り直す
    window.setTimeout(() => window.location.reload(), r.failed.length ? 2500 : 300);
    setMessage(`${r.written}件を読み込みました。ページを読み込み直します…`);
  };

  return (
    <div className="modal backup-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h2>データの書き出し・読み込み</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <p className="note">
        デッキ・カード画像・カードの加工・裏面・保存したルート・設定・続きのゲームを1つのファイルにまとめて、別のページや別の端末に移せます。
      </p>

      <section className="menu-sec">
        <h3>書き出す</h3>
        {builtinCount > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={withBuiltin} onChange={(e) => setWithBuiltin(e.target.checked)} />
            このページに最初から入っているカード画像・裏面（{builtinCount}枚）も入れる
          </label>
        )}
        <p className="note">
          デッキ {preview.decks}個・画像 {preview.images}枚（約{mb(preview.bytes)}）
          {builtinCount > 0 && withBuiltin
            ? '。カード画像が入ったファイルは、自分の引っ越し用にだけ使い、他の人には渡さないでください。'
            : ''}
        </p>
        <button className="primary" disabled={busy} onClick={() => void exportData()}>
          {busy ? '準備中…' : 'ファイルに書き出す'}
        </button>
      </section>

      <section className="menu-sec">
        <h3>読み込む</h3>
        <p className="note">
          書き出したファイルを選ぶと、今のデータに足します（同じデッキ・同じカードの画像は、ファイルの方になります）。
        </p>
        <label className="file-btn">
          ファイルを選ぶ
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void f.text().then((text) => setPendingFile({ name: f.name, text }));
            }}
          />
        </label>
        {pendingFile && (
          <div className="backup-confirm">
            <strong>「{pendingFile.name}」を読み込みますか？</strong>
            <div className="btn-row">
              <button className="primary" onClick={importData}>
                読み込む
              </button>
              <button onClick={() => setPendingFile(null)}>やめる</button>
            </div>
          </div>
        )}
      </section>
      {message && <p className="backup-message">{message}</p>}
    </div>
  );
}
