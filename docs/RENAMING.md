# Hati への名称統一

表示名は `Hati`、コマンドと保存先は `hati`、Swift型・パッケージは `Hati…`、環境変数は `HATI_…` に統一します。

| 対象 | 名前・場所 |
| --- | --- |
| iOSアプリ・共通パッケージ | `Hati` / `HatiCore` |
| iOS Bundle ID・APNs topic | `com.deep.hati` |
| macOS Bundle ID | `com.deep.hati.desktop` |
| PCコマンド・Rustバイナリ | `hati` / `hati-tui` |
| npmパッケージ | `hati-daemon` / `hati-desktop` |
| Homebrew tap・Formula | `tamoharu/hati` / `hati`（Rubyクラス `Hati`） |
| ユーザー常駐 | `com.deep.hati.daemon` / `hati.service` |
| PC設定・状態・DB | `~/.config/hati` / `~/.local/share/hati` / `hati.sqlite` |
| QR・端末鍵の形式 | `hati://pair/…` / `hati-ed25519-v1:…` |
| 通知payloadのキー | `hati` |
| iOS保存先・Keychain service | `Application Support/hati` / `hati.credentials.v1` |
| CLI状態 | `~/.local/share/hati-cli/state.json` |
| Desktop状態 | macOS `~/Library/Application Support/hati-desktop`、Linux `~/.config/hati-desktop` |
| Electron内部scheme・IPC | `hati-app` / `hati:*` / `window.hati` |
| Herdr source | `hati.agents` |
| 電源ヘルパー | `com.deep.hati.power`（実装の定義を参照） |

## 既存環境の切替

名称と永続化識別子が変わるため、新規セットアップの前に既存データを移します。空の常駐を別途起動してはいけません。

1. 設定、APIトークン、SQLite、添付、デスクトップの状態・背景を私有バックアップへ保存します。SQLiteはオンラインバックアップ、または常駐停止後の一貫したコピーを使用します。送信結果が不明な要求のIDと本文も保持します。
2. 通常セッションに実行中・承認待ちの作業がないことを確認して旧ユーザー常駐だけを停止し、旧自動起動定義を退避します。共有Codex、tmuxサーバー、一般ペインは終了しません。
3. 設定・状態を新しい保存先へ移し、DB名、`dataDir`、`tokenFile`、`codexBin`、APNs topic・鍵ファイルのパスを更新します。サーバー・プロジェクト・タブ・会話ID、要求IDと本文、トークン、SSH鍵は保持します。実行中の共有Codexを引き継ぐ場合は、同じソケットを維持し、新しいapp-serverを作りません。
4. 作業フォルダも改名する場合は `projects[].path` と `directoryMigrations` を更新します。過去の会話のcwd・本文・要求記録は書き換えず、明示した移行元から現行パスへ対応づけます。履歴を引き継ぐため、利用者の移行設定には以前の実パスが残ることがあります。
5. `hati setup --no-pair` で新常駐を登録し、`hati doctor`、serverId、タブとペインのID/PID、履歴件数を照合します。新旧常駐を同時に起動しません。
6. デスクトップの状態と背景を新しい保存先へ移し、ローカル接続のconfigPathだけを更新します。下書きや未確認要求の本文は置換しません。新しいアプリを起動し、既存の会話を読み取りで確認します。
7. iPhoneは新Bundle IDの別アプリです。旧アプリのコンテナ・Keychainを削除せず保持します。新アプリで `hati pair` のQRから接続し直します。端末内の鍵、下書き、外観は自動移行されません。通知は新App ID・プロビジョニングとAPNs設定を揃えて再登録します。
8. 旧SSH鍵や旧アプリの削除は、引継ぎを確認してから個別に行います。管理者権限が必要な電源ヘルパーは旧設定の復元後、新名称で導入します。

旧QR・通知キー・コマンドの互換エイリアスは追加しません。制御セッションの終了防止は製品名に依存しない予約名で保護します。
