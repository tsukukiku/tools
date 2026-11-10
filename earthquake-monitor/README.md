# 地震速览（第一版）

手机优先的静态网页。直接打开 `index.html` 可查看页面和底图；实时数据接口在 `file://` 模式下可能受到浏览器跨域限制，完整测试请使用本地 HTTP 服务。把整个目录放入 Cloudflare Pages 的静态输出目录即可发布，不需要构建步骤或 API 密钥。

## 数据与刷新

- 日本地震：P2PQuake JSON API v2，`codes=551`，显示其发布的最大**实测**震度。
- 日本紧急地震速报：P2PQuake `codes=556`。只在发布后 10 分钟内、未取消时显示警报；这是警报信息，不是实时地面震动图。
- 全球地震：USGS 最近 24 小时 M2.5+ GeoJSON。
- 页面可见且在线时每 60 秒刷新；后台标签暂停。失败时仅保留本次页面会话中最后一次成功的数据并标出连接失败，不生成模拟事件。
- 地图和列表按发生时间从新到旧共用编号 A–Z、A1–Z1、A2……；切换区域或震级筛选后重新编号。无有效震中坐标的事件只在列表显示。
- 地图按需加载 Leaflet；底图是项目自带的 Natural Earth 1:110m 简化国界，不请求地图瓦片。因此直接打开本地 HTML 时也不会触发 OSM 瓦片 403。此底图没有街道或日本行政区细节。

## 发布前

1. 在 GitHub 建立仓库并上传本目录文件。
2. Cloudflare Pages 连接该仓库，框架选“None”，构建命令留空，输出目录设为本目录（如果仓库根目录就是这些文件，则设为仓库根目录）。
3. 用手机检查 P2PQuake、USGS 与地图能否正常连接。上游接口从浏览器直接访问，可能受网络、跨域策略和各服务限流影响。

数据并非灾害预警的唯一依据。正式发布前应持续遵守 [P2PQuake API 条款](https://www.p2pquake.net/develop/json_api_v2/)与 [USGS 数据说明](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)。底图来自 [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) 的公开领域地图数据。
