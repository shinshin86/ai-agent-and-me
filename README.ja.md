# AI Agent and Me

Claude Code / Codex / GitHub Copilot CLI のローカルセッションログを、指定したリポジトリ（CWD）単位で横断集約し、統合タイムラインとして表示する CLI ツール。

> English: [README.md](./README.md)

## インストール / 実行

```sh
npx ai-agent-and-me <project-dir>
```

Web UI:

```sh
npm run web
# http://127.0.0.1:4732 を開く
```

## 使い方

```sh
ai-agent-and-me /path/to/your/repo
ai-agent-and-me . --agent claude,codex
ai-agent-and-me . --conversation-only                 # user/assistant のみ表示
ai-agent-and-me . --role user,assistant,tool          # ロール指定
ai-agent-and-me . --today                              # 本日分
mkdir -p tmp
ai-agent-and-me . --yesterday --format markdown --out tmp/yesterday.md
ai-agent-and-me . --date 2026-04-10                    # 特定日
ai-agent-and-me . --last 24h                           # 直近 24 時間
ai-agent-and-me . --last 7d --conversation-only        # 直近 1 週間
ai-agent-and-me . --since 2026-04-01 --until 2026-04-10
ai-agent-and-me . --format json > tmp/sessions.json
```

### オプション

| オプション | 説明 | デフォルト |
|---|---|---|
| `--agent <list>` | `claude,codex,copilot` のカンマ区切り | all |
| `--role <list>` | `user,assistant,tool,system` のカンマ区切り | all |
| `--conversation-only` | `--role user,assistant` のショートカット | false |
| `--today` | 本日でフィルタ（ローカルタイムゾーン） | false |
| `--yesterday` | 昨日でフィルタ（ローカルタイムゾーン） | false |
| `--date <ymd>` | 特定の 1 日（`YYYY-MM-DD`、ローカル TZ） | なし |
| `--last <span>` | 相対期間: `24h`, `7d`, `2w`, `30m` 等 | なし |
| `--since <value>` | 開始時刻（ISO8601 または `YYYY-MM-DD`） | なし |
| `--until <value>` | 終了時刻（ISO8601 または `YYYY-MM-DD`） | なし |
| `--format <fmt>` | `timeline` / `json` / `markdown` | `timeline` |
| `--out <path>` | 出力先ファイル | stdout |
| `--full` | メッセージ本文を省略せず全文表示（timeline） | false |
| `--width <n>` | timeline の 1 行最大文字数（`--full` 時は無視） | 120 |
| `--no-color` | 色出力を無効化 | false |
| `-v, --verbose` | 詳細ログ / `raw` フィールド付与 | false |

## リポジトリ判定

- 引数を `realpath` で正規化したうえで各セッションの CWD と**完全一致**したもののみ集約（MVP）
- **Claude Code**: `~/.claude/projects/<encoded-cwd>/*.jsonl`（ディレクトリ名は `/` → `-` エンコード）
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — 冒頭 `session_meta.cwd` で突合
- **Copilot CLI**: `~/.copilot/session-state/<id>/events.jsonl` — `session.start.context.cwd` で突合

## Web UI

`npm run web` でローカル専用の Web UI を起動できます。既定では `127.0.0.1:4732` のみで待ち受けます。

- Claude Code / Codex / Copilot CLI のログから検出したプロジェクトを一覧表示し、名前で絞り込んで**複数選択**できます
- 一覧にないプロジェクトは絶対パスを直接追加できます
- 選択したプロジェクト群を横断して会話を文字列検索できます（ヒットしたセッションは会話の流れごと表示し、ヒット箇所をハイライト）
- セッションは折りたたみ表示で、タイトル・日時・ターン数・ヒット数だけを先に表示し、クリックで会話全体を展開します
- AI の思考ログ（Claude の thinking / Codex の reasoning summary）とツール実行ログは、それぞれ折りたたみで表示・非表示を切り替えられます
- スラッシュコマンドの記録や環境情報の注入など、会話ではないノイズレコードは自動で除外します
- エージェント、期間でも絞り込めます

## 注意

- 各エージェントの JSONL スキーマは非公式で、バージョン更新で壊れる可能性があります
- ログには機密情報が含まれ得ます。エクスポート先は git 管理外に置いてください。上の例では `.gitignore` 済みの `tmp/` を使っています
- 本ツールは個人のローカル環境で使うことを前提としています。Web UI を追加する場合も、既定では `127.0.0.1` / `localhost` のみに bind し、LAN やインターネットへ公開しないでください
- 読み取り専用です。既存ログファイルへの書き込みは行いません

## ライセンス

MIT
