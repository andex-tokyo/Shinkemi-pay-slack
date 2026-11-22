# Shinkemi Pay - Cloudflare Workers版

Slack Slash Commands・MCP（Gemini / ChatGPT / Claude）・ChatGPT Custom GPT Actions から割り勘・立替・精算を Google Sheets に記録できる Cloudflare Workers アプリケーションです。

## 特徴

- **マルチクライアント対応**: Slack Slash Commands、Streamable HTTP MCP（Gemini / ChatGPT / Claude）、ChatGPT Actions JSON API を単一の Worker で提供
- **認証レスな秘密 URL 方式の MCP**: 外部 OAuth サービス（Auth0 等）不要で、Cloudflare Secret に保存したトークン付き URL で土田用・加藤用を安全に分離
- **高速レスポンス**: Cloudflare Workers を使用し、Slack の 3 秒タイムアウトに確実に対応（`response_url` への非同期返信）
- **Google Sheets 連携**: Google Sheets API を使用してスプレッドシートへ読み書き
- **Slack 通知**: `SLACK_WEBHOOK_URL` 設定時、API / MCP 経由の登録・精算・削除を Slack へ自動通知

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Google Service Account の設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. Google Sheets API を有効化
3. サービスアカウントを作成し、JSON キーをダウンロード
4. スプレッドシートをサービスアカウントのメールアドレスと共有

### 3. Cloudflare Workers の設定

1. `wrangler.toml` を編集して `SPREADSHEET_ID` を設定:

```toml
[vars]
SPREADSHEET_ID = "your-actual-spreadsheet-id"
```

2. 必要な Secret を設定:

```bash
# Google Service Account の JSON キー全体
wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY

# (オプション) Slack リクエスト署名検証用
wrangler secret put SLACK_SIGNING_SECRET

# API / MCP の内部認証・立替者固定用キー
wrangler secret put CHATGPT_ACTION_API_KEY_TSUCHIDA
wrangler secret put CHATGPT_ACTION_API_KEY_KATO

# MCP 秘密 URL 用トークン（土田用・加藤用で別々のランダム文字列）
wrangler secret put MCP_SECRET_TOKEN_TSUCHIDA
wrangler secret put MCP_SECRET_TOKEN_KATO

# (オプション) API / MCP 経由の登録・精算・削除を Slack 通知する Incoming Webhook URL
wrangler secret put SLACK_WEBHOOK_URL
```

### 4. ローカル開発・テスト・デプロイ

```bash
# ローカル開発
npm run dev

# 型チェックとテスト
npm run typecheck
npm test

# デプロイ
npm run deploy
```

## MCP 接続（Gemini / ChatGPT / Claude）

同じ Worker 上で Streamable HTTP の MCP エンドポイントを提供しています。外部の OAuth サービスは使用せず、Cloudflare Worker の Secret に保存した長いランダムトークンを含む **秘密 URL** で土田用・加藤用を識別します。

### 1. 秘密トークンを生成・設定する

土田用・加藤用それぞれ別のランダム文字列を生成し、Cloudflare Worker の Secret として設定します（Git には保存しません）。

```bash
# ランダムトークン生成（2回実行して別々の値を使う）
openssl rand -hex 24

wrangler secret put MCP_SECRET_TOKEN_TSUCHIDA
wrangler secret put MCP_SECRET_TOKEN_KATO
```

### 2. 各 AI クライアントから接続する

- 土田用 URL: `https://shinkemi-pay-slack.tsuchida.workers.dev/mcp/s/<MCP_SECRET_TOKEN_TSUCHIDA>`
- 加藤用 URL: `https://shinkemi-pay-slack.tsuchida.workers.dev/mcp/s/<MCP_SECRET_TOKEN_KATO>`

各クライアントで認証なし（OAuth 空欄 / No authentication）として上記 URL を登録します。

- **Gemini アプリ**: **カスタマイズ → 連携サービス → ＋カスタム（MCP サーバーに接続）** で URL を入力し、**その他の設定は空のまま** で **次へ → 接続**
- **ChatGPT**: Developer mode のカスタム MCP / コネクタで認証方式を **認証なし** にして URL を入力
- **Claude**: **設定 → コネクタ → カスタムコネクタを追加** で URL を入力
- **CLI（Claude Code / Gemini CLI 等）**: Streamable HTTP（`http`）の MCP サーバー URL として登録

接続後、まずは読み取り専用の操作（「最近の一覧を見せて」「未清算金額を教えて」）で動作確認してください。

> **セキュリティ注意**: 秘密 URL 自体が合鍵になるため、画面共有や外部ログへ公開しないようにしてください。漏洩した場合は `wrangler secret put` で新しい値に差し替えるだけで旧 URL を即座に無効化できます。

### 提供される MCP ツール一覧

| ツール名 | 説明 |
| --- | --- |
| `addPayEntry` | 割り勘項目を追加（立替者は URL のトークンで固定） |
| `addTatekaeEntry` | 割り勘しない立替項目を追加 |
| `settlePayment` | 相手へ実際に支払った精算額を記録 |
| `listPayEntries` | 最近 10 件の履歴と削除用のシート行番号を取得 |
| `deletePayEntry` | 指定したシート行番号（2 以上）を削除 |
| `getUnsettledAmounts` | 未清算金額を取得（正＝支払う額、負＝受け取る額） |

## Slack アプリの設定

1. [Slack API](https://api.slack.com/apps) で新しいアプリを作成
2. Slash Commands を追加:
   - `/pay` - 割り勘項目を追加
   - `/pay_tatekae` - 立替項目を追加
   - `/pay_list` - 最近の 10 項目を表示
   - `/pay_delete` - 項目を削除
   - `/pay_settle` - 相手へ支払った精算額を記録
   - `/pay_amount` - 未清算金額を表示
3. Request URL に Cloudflare Workers の URL を設定

## Slack コマンドの使い方

### `/pay`
割り勘項目を追加します。
```text
/pay <項目名> <金額> [立替者名]
```
例: `/pay ランチ 3000 土田`

### `/pay_tatekae`
立替項目を追加します（割り勘しない）。
```text
/pay_tatekae <項目名> <金額> [立替者名]
```

### `/pay_list`
最近の 10 項目を表示します。
```text
/pay_list
```

### `/pay_delete`
指定した行番号の項目を削除します。
```text
/pay_delete <行番号>
```

### `/pay_settle`
相手へ支払った金額を記録し、支払者本人の未清算額を減らします。
```text
/pay_settle <金額> [支払者名]
```
例: `/pay_settle 10000` または `/pay_settle 10000 土田`

### `/pay_amount`
未清算金額を表示します。
```text
/pay_amount
```

## ChatGPT Actions 対応（JSON API）

Slack Slash Commands および MCP に加えて、ChatGPT Custom GPT Actions から呼び出せる JSON API (`/api/*`) を提供しています。`/api/*` 配下は Bearer Token 認証を要求し、登録時の立替者は Bearer Token によって「土田」または「加藤」に固定されます。

`SLACK_WEBHOOK_URL` を設定している場合、追加・精算・削除成功時に Slack へ通知します。一覧取得と未清算金額取得では通知しません。

### OpenAPI / Privacy Policy URL

- OpenAPI: `https://shinkemi-pay-slack.tsuchida.workers.dev/openapi.yaml`
- Privacy Policy: `https://shinkemi-pay-slack.tsuchida.workers.dev/privacy`

### API 認証

```http
Authorization: Bearer <CHATGPT_ACTION_API_KEY_TSUCHIDA または CHATGPT_ACTION_API_KEY_KATO>
```

ローカル開発で試す場合は、`.dev.vars` に同じキーを設定してください。

### GPT Builder 設定例

1. GPT Builder で「Configure」→「Actions」→「Create new action」を開く
2. Schema に OpenAPI URL の内容を貼り付ける、または URL から読み込む
3. Privacy Policy URL に `https://shinkemi-pay-slack.tsuchida.workers.dev/privacy` を設定する
4. 土田用 GPT と加藤用 GPT をそれぞれ作成し、Authentication を以下のように設定する
   - Type: API Key
   - Auth Type: Bearer
   - API Key: 土田用には `CHATGPT_ACTION_API_KEY_TSUCHIDA`、加藤用には `CHATGPT_ACTION_API_KEY_KATO`
5. GPT の Instructions に「登録時の立替者は Bearer Token で API 側が固定するため、ユーザーに立替者を聞かない」と記載する

### ChatGPT Actions API 一覧

| Method | Path | operationId | 説明 |
| --- | --- | --- | --- |
| POST | `/api/pay` | `addPayEntry` | 割り勘項目を追加 |
| POST | `/api/tatekae` | `addTatekaeEntry` | 立替項目を追加 |
| GET | `/api/list` | `listPayEntries` | 最近 10 件を取得 |
| DELETE | `/api/entries/{rowNumber}` | `deletePayEntry` | 指定行を削除 |
| GET | `/api/amount` | `getUnsettledAmounts` | 未清算金額を取得 |
| POST | `/api/settle` | `settlePayment` | 認証ユーザーが相手へ支払った精算額を記録 |

## スプレッドシートの構成

以下のシートが必要です。

1. **入力シート**:
   - 列 A: 日付
   - 列 B: 項目
   - 列 C: 立替者
   - 列 D: 割り勘フラグ
   - 列 E: 金額

2. **未清算金額シート**:
   - 列 A: 名前
   - 列 B: 金額

3. **精算シート**（オプション）

## トラブルシューティング

### Slack でタイムアウトエラーが発生する場合
- Cloudflare Workers は即座に 200 OK を返し、処理は `response_url` を使って非同期で行います
- ログを確認: `wrangler tail`

### Google Sheets API エラー
- サービスアカウントがスプレッドシートにアクセス権を持っているか確認
- `SPREADSHEET_ID` が正しいか確認
- Google Sheets API が有効になっているか確認

## 開発

### ディレクトリ構成

```text
.
├── src/
│   ├── index.ts              # メインエントリーポイント（ルーティング）
│   ├── mcp.ts                # Streamable HTTP MCP サーバー（秘密 URL 方式）
│   ├── api.ts                # ChatGPT Actions 用 JSON API ハンドラー
│   ├── payment-service.ts    # API / MCP 共通のビジネスロジック
│   ├── commands.ts           # Slack コマンドハンドラー
│   ├── sheets.ts             # Google Sheets API 連携
│   ├── google-auth.ts        # Google Service Account 認証（トークンキャッシュ付き）
│   ├── slack-notifier.ts     # Slack Incoming Webhook 通知
│   ├── slack-verification.ts # Slack リクエスト署名検証
│   ├── openapi.ts            # Workers で返却する OpenAPI YAML
│   ├── privacy.ts            # Privacy Policy HTML
│   ├── utils.ts              # 共通ユーティリティ（JST 日付・定数時間比較・サニタイズ）
│   └── types.ts              # TypeScript 型定義
├── tests/
│   ├── mcp.test.mjs          # MCP エンドポイントのテスト
│   └── app.test.mjs          # API / Slack / Sheets / OpenAPI のテスト
├── openapi.yaml              # ChatGPT Actions 用 OpenAPI Schema
├── wrangler.toml             # Cloudflare Workers 設定
├── tsconfig.json             # TypeScript 設定
└── package.json              # プロジェクト設定
```

### ログの確認

```bash
wrangler tail
```

## ライセンス

ISC
