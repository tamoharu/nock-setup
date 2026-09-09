# xroamへの名称統一

2026-09-10。表示名・実行名は `xroam`、Swift型・共通パッケージは `Xroam…`、環境変数は `XROAM_…` に統一する。PCとiPhoneの識別子も変わるため、既存環境では以下の切替が必要。

| 対象 | 新しい名前・場所 |
| --- | --- |
| Bundle ID・APNs topic | `com.deep.xroam` |
| PCコマンド・npmパッケージ | `xroam` / `xroam-daemon` |
| ユーザー常駐 | `com.deep.xroam.daemon`（macOS）、`xroam.service`（Linux） |
| PC設定・状態 | `~/.config/xroam` / `~/.local/share/xroam` |
| SQLite・初期プロジェクト | `xroam.sqlite` / `~/xroamProjects` |
| 環境変数 | `XROAM_HOME`、`XROAM_CONFIG`、`XROAM_APP_ROOT`、`XROAM_NODE_BIN` など |
| QR・端末鍵の形式 | `xroam://pair/…` / `xroam-ed25519-v1:…` |
| 通知payloadのキー | `xroam` |
| iOS保存先・Keychain service | `Application Support/xroam` / `xroam.credentials.v1` |
| Herdr source・表示用変数 | `xroam.agents` / `$xroam_…` |

## 切替手順

1. 管理対象の作業を完了させる。旧版で通知登録を解除し、Herdr連携を有効にしていた場合は旧版の解除コマンドで元の表示へ戻す。設定・APIトークン・状態ディレクトリ・SQLite・添付ファイルをバックアップし、旧常駐を停止する。旧サービスの自動起動設定もバックアップ先へ移し、次回ログイン時の二重起動を防ぐ。プロジェクトのファイルやCodexのログイン情報は保持する。
2. `brew install tamoharu/xroam/xroam` で新名称のPC側を導入する。新規設定なら `xroam setup --no-pair`。状態を引き継ぐ場合は、**常駐停止中に**旧設定と状態のコピーを新しい保存先へ用意する。コピーしたSQLiteを `xroam.sqlite` に変更し、WALがある場合は対応する `-wal` / `-shm` も同じ名前に揃える。SQLiteのオンラインバックアップを使った一貫したコピーでもよい。元データは検証完了まで保持する。`attachments` もコピーする。実行中プロセスの `codex.sock` はコピーしない。
3. コピーした `config.json` の `dataDir`・`tokenFile`・`codexBin`・`apns.keyFile` を実際の新しい絶対パスへ、`apns.bundleId` を `com.deep.xroam` へ変更する。プロジェクトの `id` は保持する。作業フォルダ自体を改名した場合は `projects[].path` も実際の新しいパスに揃える。トークンは600、設定・状態ディレクトリは700を保つ。Herdrは旧版で復元を完了させ、新環境では `xroam herdr enable` で設定し直す。旧 `herdr-install.json`・`herdr.json` を有効設定としてコピーしない。
4. `xroam setup --no-pair` で新しい常駐を登録し、`xroam doctor` で稼働版を確認する。同じポートを使うため、新旧常駐を同時に起動しない。名前や保存場所が変わるので、共有Codexの監視セッションは作業完了後に新CLIで作り直す。既存の一般tmuxセッションは変更しない。
5. iPhoneへ新Bundle IDのアプリを署名して導入する。Apple Developer側でApp ID・Push Notifications・プロビジョニングを新Bundle IDに揃える。新アプリは別のアプリコンテナとKeychain serviceを使い、旧アプリの鍵・接続先・下書き・テーマを自動移行しない。必要な下書きを退避したうえで `xroam pair` のQRで接続し直し、通知を再登録する。
6. 会話履歴・プロジェクト・SSH・通知・Herdrを確認してから旧インストールを整理する。SSHの既存公開鍵は自動削除しない。取り消す鍵は登録元を確認して個別に削除する。旧アプリとバックアップは引継ぎ確認まで保持する。

旧名称の互換エイリアス、旧QRの受付、旧通知キーのフォールバックは設けない。PCとiPhoneを同時に切り替える。表示名だけを変える更新とは異なり、Bundle IDと永続化の識別子にも変更がある。

