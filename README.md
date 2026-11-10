# VanSurv JS

pygame製 [heruheru3/vansurv](https://github.com/heruheru3/vansurv)（ヴァンパイアサバイバーズ風クローン）を JavaScript へ完全移植した別リポジトリです。

- 原作リポジトリ: heruheru3/vansurv @ `1c42c0a`（2025-09-16）からフォーク
  - GitHubでは自分のリポジトリをフォークできないため、原作を起点とする独立リポジトリとして作成しています
- 描画: PixiJS 7.4.2（`vendor/` にローカル同梱、CDN依存なし）によるGPUバッチ描画
- 素材（`assets/`）とデータ（`data/`, `map/`）は原作からそのまま使用
- セーブデータは原作のJSON形式を維持し、ブラウザの localStorage に保存

## 実行方法

CSV/JSONを fetch で読み込むため、ローカルHTTPサーバー経由で開いてください（`file://` では動きません）。

```bash
python3 -m http.server 8080
# ブラウザで http://localhost:8080/ を開く
```

## 移植方針・仕様

詳細は [PORT_PLAN.md](PORT_PLAN.md) を参照。数値仕様は原作の `constants.py` と `data/*.csv` が正です。

## 進捗

移植作業中。実装状況は `STATUS.md`（作成予定）に記録します。
