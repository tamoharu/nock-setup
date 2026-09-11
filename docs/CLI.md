# hati CLI

Herdr 0.7.5のタブ配置・サイドバーのソースを基にしたRustのTUIです。
マシン → Space → Tabを表示し、モバイルと同じhati daemonへ接続します。
Herdrのdaemonや独立したCodex会話は作りません。
ソースの由来とライセンスは [Herdrの記録](../cli/third-party/herdr/README.md) を参照してください。

## 開発版を起動する

Node.js 24、Rust 1.96.1、tmuxと、接続先のhati daemonが必要です。

```sh
cd cli
cargo build --release --locked
cd ..
node remote/src/cli.mjs tui
```

初回はこのマシンの既存のhati設定を取り込みます。ローカルdaemonがなくてもSSHの接続先を登録できます。
既存のHomebrewインストールを自動更新しません。このソースから作ったパッケージでは、
`hati` または `hati tui` で起動できます。

```sh
node remote/src/cli.mjs machine add work ubuntu@workbox
node remote/src/cli.mjs machine add another work-alias --port 2222
node remote/src/cli.mjs machine add local --local --config /absolute/path/config.json
node remote/src/cli.mjs machine list
node remote/src/cli.mjs tui --json
```

パッケージ版では `node remote/src/cli.mjs` を `hati` に置き換えます。
SSHはシステムの公開鍵認証・ssh-agent・SSH configを使用します。
ホスト鍵は検証済みのものだけを受け入れます。初回は通常の `ssh` で接続を確認してください。
APIトークンは認証済みSSHから取得し、localhostのSSHトンネルでAPIへ接続します。

## 表示と同期

- 上段サイドバー: マシン → Space。マシンをクリックして展開・折りたたみます。
- 下段Agents: 全登録マシンの、会話が始まったエージェント。モバイルと同じ
  Space・Tab、マシン名、状態、実行時間、最新のユーザー指示を表示します。
- 実行中を先頭に、残りを更新順で表示します。状態フィルター、優先度順、アーカイブ表示を切り替えられます。
- 上部タブ: 実行中・入力待ち・応答完了などの状態と実行時間。応答完了はタスク全体の成功を意味しません。
- Chat: 同じthreadの会話・作業記録・確認待ち・送信キューを表示します。
- Terminal: daemonが所有する同じtmuxペインへ接続します。

接続先ごとに約2秒間隔で同期し、時間は1秒ごとに更新します。
切断または古いスナップショットは「最終確認」と表示し、実行時間をその時点で止めます。
時間はサーバーの観測時刻とローカルでの受信後経過時間から計算します。

送信済み会話、Space・Tabの名前、共有タブの表示状態、実行状態はモバイルと共有します。
接続先の登録、下書き、Agentsの表示設定はCLI端末内だけに保存します。
モバイルの接続先リスト・SSH秘密鍵・未送信下書きをコピーする機能ではありません。

## キー操作

`Ctrl+B` の後にキーを押します。マウスでもマシン、Space、Agents、タブを選択できます。

| キー | 操作 |
| --- | --- |
| `w` / `a` | Spaces / Agentsへ移動。↑↓・Enterで選択 |
| `n` / `p`、`1`〜`9` | タブ切替 |
| `c` / `s` | 現在のSpaceにCodex / シェルを作成 |
| `N` | 別のディレクトリでSpaceを作成 |
| `x` | 共有タブを非表示にする。リモートのプロセスは継続 |
| `o` | 同じ会話の端末を再開 |
| `t` / `h` | Terminal / Chat |
| `y` | 確認待ちの内容を開き、許可・拒否または質問へ回答 |
| `r` | 再同期と未確認の送信結果の照合 |
| `f` / `P` / `H` | Agentsの状態フィルター / 優先度 / アーカイブ |
| `q` | CLIを終了。daemon・tmux内の作業は継続 |
| `?` | 操作一覧 |

ChatはEnterで改行、Ctrl+Sで送信します。PageUp/Down・ホイールで履歴をスクロールできます。
Terminalではキーを接続先へ送ります。`Ctrl+B Ctrl+B` でprefix自体を送れます。
閉じたタブはAgentsから開くか、モバイルで再表示できます。

## 保存・再接続

保存先は `~/.local/share/hati-cli/state.json`（モード0600）です。
`HATI_CLI_HOME` で保存先を、`HATI_TUI_BIN` で使用するTUIバイナリを変更できます。
同じ保存先への書き込みは1つのCLIに限定します。接続先を追加・削除するときはCLIを終了してください。
`machine remove` はこのCLIの接続登録を削除し、接続先の作業やモバイルの登録は消しません。

変更要求は送信前に要求IDと本文をディスクに保存します。
結果が不明な場合は同じマシンへの次の変更を止め、`Ctrl+B r` で元のserver IDに照合します。
別のserver IDには再送せず、未確認の要求を保存します。下書きもhost/server/tab/threadごとに保持します。

通常のCLIから自動検出した端末の状態は「CLI稼働・状態未連携」のままです。
従来のmanaged sessionはAgentsと会話の閲覧に対応し、その操作はモバイルで行います。
Herdrの拡張機能・プラグインや元のdaemon全体は移植していません。

## 検証

```sh
cd cli
cargo test --locked
cargo build --locked
cd ../remote
npm test
node test/live-tui.mjs
```

ネイティブUI検証は実際のRust TUI・認証HTTP・SQLite・隔離tmuxを使用し、モデル応答だけを固定します。
日本語送信、同じ会話ID、モバイルの名前変更・再表示、状態と時間、PTY入力、閉じる／終了後のペイン存続を確認します。
記録は `cli/target/test-artifacts/` に保存します。個人の会話へテスト送信しません。

SSH全体の検証はDockerの分離コンテナを使います。公開鍵・ホスト鍵・known_hosts・daemon・tmuxはすべてテスト専用です。

```sh
docker build -f remote/Dockerfile.test -t hati-tui-ssh-test remote
cd remote
npm run test:tui:ssh
```

既存のNode.js 24・OpenSSH server・tmux入りテストイメージは `HATI_SSH_TEST_IMAGE` で指定できます。
