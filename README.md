# mirai-news-api

`mirai-news-app.html` から呼び出すローカルAPIです。  
画像は `nanobananapro`、テキストは `Gemini3 flash` を接続します。

## 1) セットアップ

```bash
cd "/Users/lizvet86/Best Practice Inc. Dropbox/用品健太/Mybrain/mirai-news-api"
npm install
cp .env.example .env
```

`.env` を編集し、以下を設定してください:

- `NANOBANANA_ENDPOINT`
- `NANOBANANA_API_KEY`（必要な場合）
- `GEMINI_API_KEY`

## 2) 起動

```bash
npm start
```

起動後:

- Health: `http://localhost:8899/health`
- 画像API: `POST /api/image/generate`
- テキストAPI: `POST /api/text/generate`

## 3) フロント接続

`mirai-news-app.html` はデフォルトで `http://localhost:8899` に接続します。  
別URLを使う場合はブラウザコンソールで以下を実行してください:

```js
localStorage.setItem("MIRAI_NEWS_API_BASE", "https://your-api.example.com");
location.reload();
```

## 4) 注意

- `nanobananapro` 側のレスポンス形式はサービスごとに差があるため、このAPIで複数形式を吸収しています。
- もし画像が返らない場合、`provider_detail` を見て `NANOBANANA_ENDPOINT` の期待ボディに合わせて `index.js` のリクエスト項目を調整してください。
