# SoundFlow

纯声音界面的 YouTube 播放器。搜索与播放履历仅保存在每位用户自己的浏览器 `localStorage`。

- 网页：`YTSound.html`
- 搜索：Cloudflare Worker + YouTube Data API
- 每次搜索：最多 50 条视频
- Worker 对同一关键词缓存 5 分钟

部署 Worker 前，在仓库 `Settings → Secrets and variables → Actions` 添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `YOUTUBE_API_KEY`

Worker 部署完成后，将 `YTSound.html` 中的 `WORKER_API_URL` 更新为实际的 `workers.dev` 地址。
