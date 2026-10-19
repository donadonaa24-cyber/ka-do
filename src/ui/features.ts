/**
 * まだ公開していない機能のスイッチ。
 * 通信対戦：仕組みは完成しているが、画面・操作には出さない（公開する時に true にし、ページに db の権限を付けて公開する）。
 * 動作確認用に、ビルド時に VITE_PVP=1 を付けると有効になる。
 */
export const PVP_ENABLED = import.meta.env.VITE_PVP === '1';
