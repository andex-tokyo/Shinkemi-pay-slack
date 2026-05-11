export const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shinkemi Pay GPT Privacy Policy</title>
  <style>
    body {
      color: #1f2937;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.7;
      margin: 0;
      padding: 32px 20px;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
    }
    h1 {
      font-size: 28px;
      line-height: 1.3;
    }
    h2 {
      font-size: 20px;
      margin-top: 32px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Shinkemi Pay GPT Privacy Policy</h1>
    <p>最終更新日: 2026-05-11</p>

    <h2>概要</h2>
    <p>Shinkemi Pay GPTは、ユーザーの依頼に基づき、支払い・割り勘・立替情報をCloudflare Workers経由でGoogle Sheetsに記録し、必要に応じてSlackに通知します。</p>

    <h2>取得・送信する情報</h2>
    <p>このGPT Actionは、ユーザーが登録・確認・削除を依頼した内容に応じて、項目名、金額、日付、立替者、割り勘種別、スプレッドシートの行番号を処理します。</p>
    <p>立替者はBearer Tokenにより「土田」または「加藤」に固定され、ユーザー入力から任意に決定されません。</p>

    <h2>利用目的</h2>
    <p>取得した情報は、支払い記録の作成、最近の記録の表示、未清算金額の確認、指定行の削除、Slackへの登録・削除通知のために利用します。</p>

    <h2>外部サービス</h2>
    <p>このGPT Actionは、Cloudflare Workers、Google Sheets API、Slack Incoming Webhookを利用します。登録・削除された内容はGoogle Sheetsに保存され、登録・削除通知はSlackに送信されます。</p>

    <h2>共有・販売</h2>
    <p>処理した情報を第三者へ販売することはありません。運用に必要な範囲で、上記の外部サービスに送信されます。</p>

    <h2>認証情報</h2>
    <p>APIキー、Google Service Account Key、Slack Webhook URLはCloudflare WorkersのSecretとして管理します。</p>

    <h2>問い合わせ</h2>
    <p>このGPT Actionの管理者に直接お問い合わせください。</p>
  </main>
</body>
</html>`;
