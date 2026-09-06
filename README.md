# Nock Setup

0.3.3でiPhoneのパス別タブ・ネイティブチャット・ディレクトリ検索・会話履歴切替に対応しました。接続先PCごとに `brew update && brew upgrade nock && nock restart` で更新してからアプリで再接続してください。常駐の再起動は管理対象の作業完了後に行ってください。

自分のPC上でCodexとtmux端末を管理する、個人向けセットアップ・常駐プログラムです。macOS / Linuxを対象とします。iPhoneアプリ本体・そのソース・署名情報はこのリポジトリに含みません。

## 導入

HomebrewがあるPCで実行します。

```sh
brew install tamoharu/nock/nock && nock setup
```

既存のCodexログインはそのまま使います。まだログインしていなければ一度だけ`nock login`。Tailscaleの接続と通常のOpenSSHサーバーも必要です。macOSではシステム設定 → 一般 → 共有 → リモートログインを有効にしてください。SSHサーバー設定やCodex設定は書き換えません。

## QRでiPhoneを接続（0.3.0以降）

対話ターミナルで`nock setup`を実行すると、常駐起動後にQRを表示します。iPhoneのNockで「QRで接続」を開いて読み取ると、iPhone内で鍵を生成し、PCへ公開鍵だけを登録してSSH接続します。秘密鍵・パスフレーズ・APIトークンの手動コピーは不要です。アプリ0.3.0以降が必要です。

設定済みのPCでQRをもう一度表示する場合：

```sh
nock pair
```

Macでは大きなQRのローカル画面も開きます。ターミナルだけで使う場合は`nock pair --no-open`。SSHが22以外なら`nock pair --ssh-port 2222`。自動化環境やQR不要の場合は`nock setup --no-pair`。非対話・`--quiet`・`--no-start`ではQRを自動表示しません。

0.3.1ではターミナル用QRの誤り訂正レベルをLにして表示を小さくしました。接続情報によってサイズは変わります。収まらない場合はターミナルの文字サイズを下げるか、ウィンドウを広げて再実行してください。iPhoneアプリは0.3.0以降をそのまま利用できます。

- 登録窓口は自分のTailscale IPv4にだけ一時的にbindします。LAN全体・公開インターネット・0.0.0.0にはbindしません。制御APIは従来どおりlocalhostです。Tailscale ACLで登録時の一時TCPポートとSSHを許可する必要があります。
- QRには256ビットの使い捨て登録券、TLS証明書のSHA256、SSHホスト公開鍵のSHA256、接続情報が入ります。秘密鍵は含みません。登録通信はOS / NodeのTLS 1.2以降で暗号化し、QRの証明書ハッシュと一致する相手だけに公開鍵を送ります。
- **QRを読んだ端末には、実行ユーザーとしてSSH・シェル操作できる権限を与えます。** 自分のPCで発行したQRだけを読み取り、画面共有・ログ・チャット・Gitへ載せないでください。有効期限5分、1台限りです。
- 既存の`~/.ssh/authorized_keys`を保持して`nock:要求ID`付きの行を追記します。異常な所有者・権限・symlinkは拒否し、自動的には修正しません。標準の`AuthorizedKeysFile`を使用するOpenSSHが対象です。独自のパス・ホスト鍵構成では手動登録を使ってください。
- 登録直後に切断しても、iPhoneのKeychainに同じ鍵と要求IDを保持します。「QRで接続」から再試行でき、SSH接続で受理済みか確認します。再試行で別の鍵を作りません。保存済みホスト鍵と異なるQRは自動的に信頼しません。
- SSH接続確認後、期限切れ、Ctrl+Cで登録窓口を閉じます。登録済みのSSH公開鍵は期限切れでも残します。PC・iPhoneが終了しても既に登録された鍵は有効です。

登録を取り消す場合は、PCで`~/.ssh/authorized_keys`をバックアップし、該当する末尾`nock:要求ID`の行だけを削除してください。他の鍵やオプションを削除しないでください。これは新規接続を拒否する操作で、既に接続済みのSSHやtmuxの終了とは別です。アプリの再インストール等でiPhone側の鍵が失われた場合も古い行を削除し、新しいQRで登録します。

登録中に強制終了して`.ssh/.nock-pair.lock`が残った場合は、他の`nock pair`処理が終了していることを確認して、このロックファイルだけを削除して再試行してください。

`nock doctor`でSSH・Tailscale・Codex・通知設定を確認できます。秘密のAPIトークンを表示する必要はなく、アプリがSSH認証とホスト鍵確認の後に自動取得します。

```sh
nock project add /absolute/path/to/project
```

プロジェクト追加は常駐を再起動せず反映されます。

## PCとiPhoneで同じ端末を使う

Spaceはtmuxセッション、タブはウィンドウです。分割済みウィンドウはペイン番号付きで選べます。すでにある通常のtmuxセッションは自動検出し、その端末へattachします。端末を開いただけでは別のCodexを起動しません。

状態・通知も連携する新しいCodexをPCで開始する場合：

```sh
nock codex
```

tmuxの外では新しい共有Codex Spaceを作って接続します。tmuxの中では現在のペインで共有Codexを開始します。既に動作中のCodexを二重起動する操作ではありません。通常のシェル操作はそのまま行えます。

Codex 0.153.4の公式`--remote unix://...`を利用します。共有app-serverは非公開のUnixソケット（600、親ディレクトリ700）と専用tmuxセッションに置き、監視用のNock常駐が切れてもCodexを継続します。通常のCLIを後からapp-server管理へ強制移行することはしません。連携なしで起動したCLIは端末共有のみで、「稼働・状態未連携」と表示し、正確な承認待ち・完了通知は保証しません。

端末のキー入力は通常のSSH端末と同じです。送信直後に切断した入力を自動再送しません。共有端末の承認・質問はCodex CLIで回答します。PCとiPhoneから同時に入力すると混ざるため、入力する端末を一方に決めてください。

### 共有時の画面サイズとスクロール（0.3.2以降）

iPhoneはtmuxの`ignore-size`クライアントとして接続します。PCが接続中はスマホの小さな画面やキーボード表示でPCの画面を縮めません。PCを切断してスマホだけになれば、スマホのサイズが使われます。両方の接続中は一つのPTYを共有するため、スマホではPC画面の一部が表示されます（個別の折り返し表示ではありません）。入力は両方から可能で、PCを強制切断しません。PCが複数ある場合のサイズ選択は既存のtmux設定に従います。

0.3.4では、iPhoneからの接続に加え、PC側の`nock codex`でも接続対象のtmuxセッションだけ`mouse on`を設定します。iPhoneを接続していないPC端末でも、ホイールで履歴を上下に移動できます。PCの上スクロールはtmuxの履歴表示に入り、終了は`q`。キーボードでは既定の`Ctrl-b`の後に`[`、Page Upで遡れます。独自のprefix・キーバインドはその設定を使ってください。グローバル設定や独自のマウスキー割当は変更しません。セッションへの設定を解除する場合は`tmux set-option -u -t セッション名 mouse`（Nockで再接続すると再び有効になります）。tmuxがマウスを扱うため、ターミナルアプリ独自の文字選択とは動作が変わります。

新規の`nock codex`は固定版Codexの`--no-alt-screen`で起動し、tmuxのスクロールバックを残します。通常のCLIを自分で起動する場合も`codex --no-alt-screen`が使えます。既存のCodexは自動的に再起動しません。代替画面を使う既存CLIや独自のマウス割当では、ホイールで履歴に入れない場合があります。その場合は上記のtmuxコピーモードを使ってください。tmuxが保持していない過去の画面をこの修正で復元することはできません。

画面サイズ・マウスの修正は`brew update && brew upgrade nock`後、iPhoneの端末を閉じて開き直すと反映されます。既に開いているPCのtmuxセッションへ適用する場合は、そのセッション内で`tmux set-option mouse on`を実行してください。動作中のCodexを再起動する必要はありません。アプリ更新・QR再登録・常駐再起動は不要です。アプリから新しく作るCodexの`--no-alt-screen`適用のみ、作業終了後の常駐更新が必要です。

仕様：[tmux公式マニュアル](https://man.openbsd.org/tmux)、[Codex CLI公式オプション](https://developers.openai.com/codex/cli/reference)。

標準tmuxソケットを検出します。独自の`tmux -S`を使う場合はNockの設定に`"tmux": {"socket": "/absolute/path/to/tmux.sock"}`を指定します。別ユーザーや別ソケットを無条件に走査しません。

## HerdrのAgents表示をNockと揃える

起動済みのHerdr 0.7.5以降で、Nock常駐を起動してから実行します。

```sh
nock herdr enable
nock herdr status
# 元のサイドバー設定へ戻す
nock herdr disable
```

Herdrの全Spaceにあるエージェントを、実行中優先・新しい活動順で表示します。マシン名、Space名、Tab名、最後のユーザー指示（2行の抜粋）、状態、今回の実行時間を表示します。実行中の標識とタブはオレンジ、Agentsの標識はHerdr標準の回転表示です。サイドバーの最大幅は40文字になります。

Codexの会話は、各ペインの前景プロセスが開く構造化会話ファイルから特定します。Herdr内の`nock codex`は、現在表示中のtmuxペインとNockの会話を照合します。既存の会話を再開したり指示を送ったりする処理はありません。通常のCodexには`lsof`が必要です（macOSは標準搭載）。会話を特定できない場合は「指示未取得」、実行時間を特定できない場合は「時間不明」を表示します。`≥0:12`は観測開始から12秒以上の意味です。完了後は時間が止まります。

対象は指定したローカルHerdrセッションです。別PCのエージェントを仮想ペインとして追加する機能は含みません。別のソケットや設定ファイルを使う場合は、`nock herdr enable --socket /absolute/path/herdr.sock --herdr-config /absolute/path/config.toml --host-name MyMac`で指定できます。

設定は再読み込みで反映し、端末を再起動しません。元の表示設定はNockのデータディレクトリの`herdr-install.json`に保存します。元の設定ファイルがシンボリックリンクの場合も保持します。無効化時は無関係な設定変更を保持して復元します。Nockが管理する行を手動変更した場合は、上書きせずバックアップの確認を案内します。色にはHerdrの`theme.custom.yellow`を使用するため、テーマ内で同じ色を使う箇所にも適用されます。

実装はHerdrの[サイドバー行設定](https://herdr.dev/docs/configuration/#sidebar-row-layouts)と[Socket API](https://herdr.dev/docs/socket-api/#agent-view-queries)を使用しています。

## 通知の設定

通知中継サービスは使いません。PCから直接Apple APNsへ送ります。APNs鍵は利用者が用意する必要があり、未設定でも端末と会話は使用できます。[APNs設定](docs/APNS.md)を参照してください。

## 更新・停止・削除

```sh
brew update
brew upgrade nock
nock restart
```

従来の構造化会話モードで実行中の作業は、`nock restart`により中断するため完了後に更新してください。新しい共有tmuxタブは監視接続の終了だけでは停止しません。Linuxでは新しく起動するtmuxサーバーを別のsystemdユーザースコープへ置きます。実OS再起動ではプロセスが失われるので、勝手にターンを再実行せず、状態未確認として表示します。

```sh
brew services stop nock
brew uninstall nock
```

設定・トークン・履歴は削除しません。tmux端末の終了も別操作です。不要になった端末はそのシェルを`exit`するか、対象を確認して`tmux kill-session -t セッション名`を実行してください。他の端末を巻き込む`tmux kill-server`は通常不要です。

Linuxでログアウト後も継続するには、一度だけ`loginctl enable-linger ユーザー名`が必要になる場合があります。macOSはユーザーlaunchdで常駐します。Macのスリープ中には通信できず、ログアウト・OS再起動時のプロセス継続は保証しません。

保存先：`~/.config/nock`（設定と600のトークン）、`~/.local/share/nock`（700の状態ディレクトリ）、`~/NockProjects`（初期プロジェクト）。

## 固定依存関係

Node.js 24、Codex CLI 0.153.4、ws 8.21.3、qrcode 1.5.4。tmuxとOpenSSL 3はHomebrew / OSの保守版を使用します。暗号通信やターミナルエミュレーションは自作していません。Codexは通常CLIと同じ認証・利用枠を使い、別のモデルAPI契約を必須にしません。

- [Codex app-server公式資料](https://developers.openai.com/codex/app-server)
- [Codex 0.153.4のソース](https://github.com/openai/codex/tree/rust-v0.153.4)
- [ws](https://github.com/websockets/ws)（MIT）
- [qrcode](https://github.com/soldair/node-qrcode)（MIT）、[OpenSSL](https://www.openssl.org/)（3.x: Apache-2.0）
- [tmux](https://github.com/tmux/tmux)（ISC系）

この公開範囲はPC側セットアップに限定しています。iPhoneアプリは非公開で、ここからダウンロードできません。

## 0.3.4 の更新

PC端末からの起動時のスクロール有効化、Workspace一覧取得の待ち時間削減、会話タイトルの整合、コード閲覧APIと実行時間の取得を含みます。常駐側の変更は進行中の作業が終わってから`nock restart`で適用してください。

## 0.3.5 の更新と Ubuntu での反映確認

Macで稼働している現行PC側モジュールを配布します。コード閲覧、Workspaceの応答改善、会話の再表示、任意のHerdr連携を含みます。Herdrは有効化しない限り不要です。

```sh
brew update
brew upgrade tamoharu/nock/nock
# 実行中の作業が終わってから常駐を更新
nock restart
nock doctor
```

`brew upgrade`だけでは、既に動いているNock常駐のコードは入れ替わりません。`nock doctor`で「パッケージ: 0.3.5 / 稼働中: 0.3.5」「コード閲覧: 準備済み」を確認し、iPhoneで接続先へ再接続してください。JSON出力は`installedVersion`、`daemonVersion`、`codeBrowser`、`restartRequired`を返します。旧常駐がバージョン情報を返さない場合も、更新未反映と表示します。

0.3.4にもコード閲覧APIは含まれています。最新版をインストール済みなのに未対応と表示される場合は、まず稼働中の常駐と接続先を確認してください。独自のsystemd unitや手動導入を併用している場合は、同じポートへ別の旧Nockを起動しないよう、起動元を確認してください。
