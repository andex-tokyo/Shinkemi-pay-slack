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

### 4. ローカル開発

```bash
npm run dev
```

### 5. デプロイ

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
│   ├── types.ts          # TypeScript型定義
│   ├── sheets.ts         # Google Sheets API連携
│   ├── commands.ts       # Slackコマンドハンドラー
│   └── slack-verification.ts # Slackリクエスト検証
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