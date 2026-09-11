# Apple APNs設定

Apple DeveloperアカウントでAPNs認証鍵（.p8）を発行し、PC側の本人だけが読める場所へ600の権限で保存します。GitやiPhoneアプリへ鍵を含めないでください。

`~/.config/hati/config.json`の`apns`に設定します。

```json
{
  "enabled": true,
  "teamId": "YOUR_TEAM_ID",
  "keyId": "YOUR_KEY_ID",
  "bundleId": "com.deep.hati",
  "keyFile": "/absolute/private/path/AuthKey.p8"
}
```

実行中の作業を確認してから`hati restart`で反映します。iPhone側の署名とPush Notifications capabilityは利用者側で設定します。development / production環境はデバイストークン登録と署名設定で区別されます。

アプリで通知権限を許可し、SSH経由でデバイストークンを登録してください。SSH接続テストとは別に通知テストを実施します。失効トークンは無効化し、永続キューから期限付き再試行します。APNsの200応答は受理を示し、端末への表示を保証しません。

既定の通知にはプロジェクト・Space・タブ名と状態だけを含めます。本文、コマンド、機密情報を含む名前を設定しないでください。

[Apple APNs公式資料](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server)
