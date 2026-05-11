# Shinkemi Pay Slack Bot - Cloudflare Workers版

SlackのタイムアウトBを解決するため、Google Apps Script(GAS)からCloudflare Workersに移行したSlackボットです。

## 特徴

- **高速レスポンス**: Cloudflare Workersを使用し、Slackの3秒タイムアウトに確実に対応
- **非同期処理**: 重い処理はresponse_urlを使用して非同期で実行
- **Google Sheets連携**: Google Sheets APIを使用してスプレッドシートにデータを保存
- **TypeScript**: 型安全な開発環境

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Google Service Accountの設定

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作成
2. Google Sheets APIを有効化
3. サービスアカウントを作成し、JSONキーをダウンロード
4. スプレッドシートをサービスアカウントのメールアドレスと共有

### 3. Cloudflare Workersの設定

1. `wrangler.toml`を編集してSPREADSHEET_IDを設定:

```toml
[vars]
SPREADSHEET_ID = "your-actual-spreadsheet-id"
```

2. Google Service AccountのJSONキーをシークレットとして設定:

```bash
wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
# JSONキー全体をペースト
```

3. (オプション) Slack Signing Secretを設定:

```bash
wrangler secret put SLACK_SIGNING_SECRET
# Slackアプリの設定からSigning Secretをコピーしてペースト
```

4. ChatGPT Actions API Keyを設定:

```bash
wrangler secret put CHATGPT_ACTION_API_KEY_TSUCHIDA
# 土田用GPT BuilderのBearer Tokenに設定する値を入力

wrangler secret put CHATGPT_ACTION_API_KEY_KATO
# 加藤用GPT BuilderのBearer Tokenに設定する値を入力
```

5. (オプション) ChatGPT Actions経由の登録・削除をSlack通知する場合はIncoming Webhook URLを設定:

```bash
wrangler secret put SLACK_WEBHOOK_URL
# Slack Incoming Webhook URLを入力
```

### 6. ローカル開発

```bash
npm run dev
```

### 7. デプロイ

```bash
npm run deploy
```

## Slackアプリの設定

1. [Slack API](https://api.slack.com/apps)で新しいアプリを作成
2. Slash Commandsを追加:
   - `/pay` - 割り勘項目を追加
   - `/pay_tatekae` - 立替項目を追加
   - `/pay_list` - 最近の10項目を表示
   - `/pay_delete` - 項目を削除
   - `/pay_amount` - 未清算金額を表示
3. Request URLにCloudflare WorkersのURLを設定

## コマンドの使い方

### /pay
割り勘項目を追加します。
```
/pay <項目名> <金額> [立替者名]
```
例: `/pay ランチ 3000 土田`

### /pay_tatekae
立替項目を追加します（割り勘しない）。
```
/pay_tatekae <項目名> <金額> [立替者名]
```

### /pay_list
最近の10項目を表示します。
```
/pay_list
```

### /pay_delete
指定した行番号の項目を削除します。
```
/pay_delete <行番号>
```

### /pay_amount
未清算金額を表示します。
```
/pay_amount
```

## ChatGPT Actions対応

Slack Slash Commandsの既存処理に加えて、ChatGPT Custom GPT Actionsから呼び出せるJSON APIを提供しています。Slack向けの署名検証、即時200 OK、`response_url`への非同期返信、`ctx.waitUntil()`の構成は維持したまま、`/api/*`配下だけBearer Token認証を要求します。

登録時の立替者はリクエスト本文ではなくBearer Tokenで固定します。土田用Tokenを設定したGPTは常に土田、加藤用Tokenを設定したGPTは常に加藤として登録します。

`SLACK_WEBHOOK_URL`を設定している場合、ChatGPT Actions経由の追加・削除成功時にSlackへ通知します。一覧取得と未清算金額取得では通知しません。

### OpenAPI URL

```text
https://shinkemi-pay-slack.tsuchida.workers.dev/openapi.yaml
```

### API認証

ChatGPT Actions APIは以下のヘッダーで認証します。

```http
Authorization: Bearer <CHATGPT_ACTION_API_KEY_TSUCHIDA または CHATGPT_ACTION_API_KEY_KATO>
```

Cloudflare Workers本番環境では、以下のSecretを設定してください。

```bash
wrangler secret put CHATGPT_ACTION_API_KEY_TSUCHIDA
wrangler secret put CHATGPT_ACTION_API_KEY_KATO
wrangler secret put SLACK_WEBHOOK_URL
```

本番ではSecretとして管理します。ローカル開発でAPI認証やSlack通知を試す場合は、`.dev.vars`に同じキーを設定してください。

### GPT Builder設定例

1. GPT Builderで「Configure」→「Actions」→「Create new action」を開く
2. SchemaにOpenAPI URLの内容を貼り付ける、またはURLから読み込む
3. 土田用GPTと加藤用GPTをそれぞれ作成し、Authenticationを以下のように設定する
   - Type: API Key
   - Auth Type: Bearer
   - API Key: 土田用GPTには`CHATGPT_ACTION_API_KEY_TSUCHIDA`、加藤用GPTには`CHATGPT_ACTION_API_KEY_KATO`の値
4. GPTのInstructionsには「登録時の立替者はこのGPTに設定されたBearer TokenでAPI側が固定するため、ユーザーに立替者を聞かない」と記載する

### ChatGPT Actions API一覧

| Method | Path | operationId | 説明 |
| --- | --- | --- | --- |
| POST | `/api/pay` | `addPayEntry` | 割り勘項目を追加 |
| POST | `/api/tatekae` | `addTatekaeEntry` | 立替項目を追加 |
| GET | `/api/list` | `listPayEntries` | 最近10件を取得 |
| DELETE | `/api/entries/{rowNumber}` | `deletePayEntry` | 指定行を削除 |
| GET | `/api/amount` | `getUnsettledAmounts` | 未清算金額を取得 |

### 想定利用例

- 「ランチ1200円を割り勘登録して」
- 「最近の立替一覧を見せて」
- 「未清算金額を教えて」
- 「5行目を削除して」

## スプレッドシートの構成

以下のシートが必要です：

1. **入力シート**: 
   - 列A: 日付
   - 列B: 項目
   - 列C: 立替者
   - 列D: 割り勘フラグ
   - 列E: 金額

2. **未清算金額シート**:
   - 列A: 名前
   - 列B: 金額

3. **精算シート** (オプション)

## トラブルシューティング

### タイムアウトエラーが発生する場合
- Cloudflare Workersは即座に200 OKを返し、処理はresponse_urlを使って非同期で行います
- ログを確認: `wrangler tail`

### Google Sheets APIエラー
- サービスアカウントがスプレッドシートにアクセス権を持っているか確認
- SPREADSHEET_IDが正しいか確認
- Google Sheets APIが有効になっているか確認

## 開発

### ディレクトリ構成
```
.
├── src/
│   ├── index.ts          # メインエントリーポイント
│   ├── api.ts            # ChatGPT Actions用JSON API
│   ├── openapi.ts        # Workersで返却するOpenAPI YAML
│   ├── types.ts          # TypeScript型定義
│   ├── sheets.ts         # Google Sheets API連携
│   ├── commands.ts       # Slackコマンドハンドラー
│   └── slack-verification.ts # Slackリクエスト検証
├── openapi.yaml          # ChatGPT Actions用OpenAPI Schema
├── wrangler.toml         # Cloudflare Workers設定
├── tsconfig.json         # TypeScript設定
└── package.json          # プロジェクト設定
```

### ログの確認
```bash
wrangler tail
```

## ライセンス

ISC
