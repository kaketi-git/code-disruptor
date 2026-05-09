# 🕵️ コード・ディスラプター — デプロイ手順

## ファイル構成
```
disruptor/
├── server.js        # Node.js + Socket.io サーバー
├── package.json
├── .gitignore
└── public/
    └── index.html   # ゲーム画面（全プレイヤー共通）
```

---

## ① GitHubにアップロードする

### 1. GitHubでリポジトリを作成
1. https://github.com にログイン
2. 右上の「+」→「New repository」をクリック
3. Repository name: `code-disruptor`
4. Public を選択
5. 「Create repository」をクリック

### 2. ファイルをアップロード
リポジトリページの「uploading an existing file」リンクをクリック、
または以下のコマンドをターミナルで実行：

```bash
cd disruptor
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/code-disruptor.git
git push -u origin main
```

---

## ② Renderでサーバーを起動する

1. https://render.com にアクセスしてサインアップ（GitHubアカウントでOK）
2. ダッシュボードで「+ New」→「Web Service」をクリック
3. 「Connect a repository」→ `code-disruptor` を選択
4. 以下の設定を入力：

| 項目 | 値 |
|------|-----|
| Name | code-disruptor（任意） |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

5. 「Create Web Service」をクリック
6. 数分後にデプロイ完了 → URLが発行される（例: `https://code-disruptor-xxxx.onrender.com`）

---

## ③ 遊び方

1. ホストが上記URLにアクセスし、名前を入力して「ルームを作成」
2. 表示された**5文字のルームコード**を他の3人に共有
3. 他のプレイヤーは同じURLにアクセスし、名前 + ルームコードを入力して「ルームに参加」
4. 4人揃ったらホストが「ゲーム開始」をクリック

---

## 注意事項
- Renderの無料プランは**15分間アクセスがないとスリープ**します（最初のアクセスに30秒ほどかかる場合があります）
- スリープを防ぎたい場合は有料プラン（$7/月）にアップグレードしてください
