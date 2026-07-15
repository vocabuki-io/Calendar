# 年度カレンダー（PWA）

4月始まり（年度）の白基調のシンプルなカレンダーです。日付をタップして **〇** を付け、
曜日ごとに「今年4月〜来年3月」の合計を集計します。GitHub Pages で公開でき、
**どの端末からでも同じ URL にアクセスして丸を付け外し**でき、端末間でほぼ即時に同期します。

## 特徴

- 📅 4月始まり（年度）の月表示。左右の矢印で先月／来月へ（年度内で移動）。
- ⭕ 日付を **タップで〇を付ける**、**長押しで削除**。
- 📊 下部の曜日カードに、年度内でその曜日に付いた〇の個数を表示。
- ☁️ データは GitHub 上の JSON に保存。**どの端末からでも即時反映**。
- 📱 PWA（ホーム画面に追加してアプリのように使える／オフラインでも表示）。

## 仕組み（同期）

アプリ本体は GitHub Pages が配信する静的ファイルです。丸のデータは
GitHub の **Contents API** を通じて `data.json` に読み書きします（`calendar-data`
ブランチに保存し、丸を付けるたびに Pages が再ビルドされないようにしています）。
読み書きはブラウザから直接 API を叩くため、**Pages の再ビルドを待たずに即時反映**されます。

書き込みには GitHub のトークンが必要です。トークンは **URL のフラグメント**で渡します。

```
https://<owner>.github.io/<repo>/#t=<あなたのトークン>
```

例:

```
https://vocabuki-io.github.io/Calendar/#t=github_pat_xxxxxxxxxxxxxxxx
```

- 一度 URL でトークンを渡すと、その端末の `localStorage` に保存され、以降は
  ハッシュ無しの URL（`https://vocabuki-io.github.io/Calendar/`）でも編集できます。
- トークンは **URL に残したまま**にしています。トークン入りリンクをブックマーク/共有すれば
  どの端末でもそのまま編集できます（その代わり、URL バー・履歴・ブラウザ同期に書き込み用
  トークンが残る点にご注意ください。共有先は信頼できる相手に限ってください）。
- トークンが無い端末では **閲覧のみ**（公開リポジトリなら閲覧可）。編集しようとすると
  「トークンを付けてください」と案内が出ます。
- 端末に保存したトークンを消したい場合は、ブラウザのサイトデータ（`localStorage`）を
  削除してください。

## セットアップ手順

### 1. このリポジトリを用意

`main` ブランチにこの一式（`index.html` などの静的ファイル）を置きます。

### 2. GitHub Pages を有効化

リポジトリの **Settings → Pages** で、Source を **GitHub Actions** に設定します。
`main` に push すると `.github/workflows/deploy.yml` が動き、Pages に公開されます。
公開 URL は `https://<owner>.github.io/<repo>/` です。

### 3. トークンを作成（書き込み用）

**Settings → Developer settings → Personal access tokens → Fine-grained tokens** で作成:

- **Repository access**: このリポジトリのみ（Only select repositories）
- **Permissions → Repository permissions → Contents**: **Read and write**
- 有効期限は用途に合わせて設定

作成したトークン（`github_pat_...`）を URL の `#t=` に付けてアクセスします。

### 4. 使う

各端末で `https://<owner>.github.io/<repo>/#t=<トークン>` を開き、ホーム画面に追加。
以降はホーム画面のアイコンから開けば、その端末では自動でトークンが使われます。

## ⚠️ セキュリティ上の注意

- **URL に付けるトークンは、そのリポジトリに書き込める鍵**です。トークン付きの URL を
  他人に共有しないでください。
- 権限は上記の通り **このリポジトリの Contents のみ**に絞った Fine-grained トークンを
  使ってください（万一漏れても影響を最小化できます）。
- リポジトリが **公開**の場合、`data.json`（丸の日付）は誰でも閲覧できます。
  日付を他人に見られたくない場合は **非公開リポジトリ**にしてください
  （その場合、閲覧にもトークンが必要になります）。
- トークンが漏れたと思ったら、GitHub の設定から即座に **失効（Revoke）** させてください。

## 設定の上書き

`js/app.js` 冒頭の `CONFIG` で owner / repo / データの保存先を変更できます。
`github.io` から owner・repo を自動判定するので、通常は変更不要です。

## Cloudflare を使いたい場合

「トークンを URL に出したくない」場合は、Cloudflare Workers（または Pages Functions）に
トークンを **サーバー側（環境変数）** で持たせ、Worker 経由で `data.json` を読み書きする
プロキシを立てる方法もあります。その場合、`js/app.js` の `API` と `commitChange` /
`readData` を Worker のエンドポイントに向け替えてください。本リポジトリの既定は、
追加サーバー不要な **GitHub トークン方式** です。
