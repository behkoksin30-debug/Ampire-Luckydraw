# 幸运抽奖系统

参与者登记资料（含订单截图、OCR辅助识别订单号/金额） + 后台管理奖品与开奖的网页系统。

## 本地运行

```
npm install
npm start
```

打开 http://localhost:3000

## 数据存储

默认存在项目根目录的 `data/` 文件夹。部署到 Railway 时通过环境变量 `DATA_DIR` 指向一个挂载了 Volume 的路径（例如 `/data`），确保重新部署时资料不会丢失。

## 目录结构

```
server.js        Express 后端与所有 /api 接口
package.json
public/index.html  前端页面（登记表单 + 后台管理）
```
