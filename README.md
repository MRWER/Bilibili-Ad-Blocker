## 项目结构
```text
Bilibili-Ad-Blocker/
├── icons/                   # 插件图标文件夹
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── manifest.json            # 插件的配置文件，定义权限、脚本等
├── content.js               # 内容脚本，注入到B站页面，负责UI和交互
├── ad-detector.js           # 广告检测模块，实现各种判断逻辑
├── background.js            # 后台服务脚本，处理跨页面通信和API调用
├── popup.html               # 用户点击插件图标时弹出的界面
└── popup.js                 # 弹出界面的交互逻辑
```