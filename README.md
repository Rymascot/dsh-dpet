# DPet：DSH 的 2D/3D 智能桌宠

[English](README.en.md)

DPet 是 [DeepSeek Harness（DSH）](https://github.com/zhu1090093659/dsh-web) 的桌宠插件。它把**任何形象**（3D 模型、图片、GIF）变成一只悬浮在 DSH 界面上的桌宠，并且**跟着 AI 的工作状态做动作**：AI 思考时转身，跑命令时蹦跶，完成时欢呼，出错时低头。

示范形象是大连东软信息学院的吉祥物「东东」，模型由腾讯混元 3D 从图片生成。

## 特点

- **2D / 3D 都能用**：3D 用 three.js 实时渲染 `.glb` 模型；2D 支持 PNG、JPG、WebP 和 GIF。
- **拖进来就能用**：在设置页把文件拖进去就变成桌宠，不用写配置、不用切图。
  - **3D 模型自动瘦身**：自动减面、压缩贴图。实测把一个 76 MB、150 万面的 AI 生成模型在几秒内压到 1.8 MB、5 万面；导入后自动截图生成封面。
  - **图片自动去背景**：白底、纯色底的图会自动去掉背景，边缘做柔化处理、去掉白边残留；生成桌宠前会并排显示「原图」和「去掉背景后」，由你选择用哪个。背景不是纯色的图会保留原样，不会误删。
  - GIF 保留原动画。
- **2D 不再是“纸片”**：
  - **果冻变形**：图片被切成 40 条横向切片，按离脚的高度分别变形。摇摆时脚不动、越往上摆得越大，像身体在弯；呼吸时胸口以上起伏；蹦跶落地时挤扁再弹回；上半身的动作稍微慢半拍，整体显得软。
  - **不翻卡片**：转身改成最多 14° 的透视倾斜，不会出现“一张纸转过去”。
  - **脚下有影子**：柔和的接触阴影，跳起来时变小变淡。3D 模型也有同样的影子。
- **2D 和 3D 共用一套动作**：呼吸、张望、转圈、蹦跶、点头、欢呼、低落、静止。
- **跟着 AI 动**：插件监听 DSH 的会话事件，把 AI 的状态映射成 7 种：空闲、准备、思考、调用工具、回复中、完成、出错。每种状态做什么动作，可以在「动作编排」里自己选。
- **状态气泡自适应**：气泡始终停在桌宠头顶上方，间距和字号随桌宠大小变化；桌宠被拖到屏幕顶部时，气泡自动挪到下方。
- **可视化设置**：实时预览舞台、卡片式图鉴、拖动摆放位置、大小/透明度滑块、看向鼠标、状态气泡。界面使用 DSH 的设计变量，自动适配深浅色主题。

## 安装

需要 DSH 0.1.7-rc.1 或更高版本、Node.js 22.19+、pnpm。

```bash
git clone https://github.com/Rymascot/dsh-dpet.git
cd dsh-dpet
pnpm install
pnpm build
```

然后把插件挂到 DSH 的 web 配置上（把路径换成你的实际路径）：

```bash
dsh plugin --profile web add link:/path/to/dsh-dpet
```

重启 DSH，右下角会出现东东，设置里多出「桌宠」页。

## 使用

- **拖动**桌宠换位置，**点它**会 Q 弹一下并说句话。显示或隐藏桌宠在「设置 → 桌宠」右上角的开关里。
- **设置 → 桌宠**：
  - 预览舞台下面的状态按钮可以预览每种 AI 状态的动作。
  - 「我的桌宠」里点卡片预览，再点「设为桌宠」。把 `.glb` 或图片拖到页面上即可导入；图片会先让你确认去背景的效果。
  - 「动作编排」给每种状态选动作，「位置与外观」调整大小、透明度和位置。

数据保存在 `$DSH_HOME/dpet/`：`settings.json` 是设置，`pets/` 里是你导入的形象。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm test        # 单元测试 + 路由集成测试
pnpm build       # 构建 lib/（主机端、浏览器端、three.js 分包）
```

### 项目结构

插件分成后端（跑在 DSH 进程里）和前端（跑在浏览器里）两半，目录按 Spring Boot + Vue 的习惯组织：

```
src/
├── server/                      后端（≈ Spring Boot）
│   ├── index.ts                 启动与装配（≈ 启动类 + 配置类）
│   ├── controller/routes.ts     /api/dpet/* 接口与文件服务（≈ Controller）
│   ├── service/
│   │   ├── activity.ts          把 DSH 会话事件映射成 7 种状态（≈ 事件监听 Service）
│   │   ├── importer.ts          导入管线：识别格式、3D 减面压缩、图片处理
│   │   └── background.ts        纯色背景去除：边缘洪水填充、柔化边缘、去白边
│   ├── repository/
│   │   ├── library.ts           宠物库：内置形象 + 用户导入的形象（读写磁盘）
│   │   └── settings.ts          设置的校验与保存
│   └── common/
│       ├── http.ts              访问控制（仅本机、校验来源）、请求体读取（≈ 拦截器 + 工具类）
│       └── files.ts             文件工具
├── shared/types.ts              前后端共用的数据结构（≈ DTO）
└── client/                      前端（≈ Vue 项目）
    ├── index.ts                 入口：挂载悬浮桌宠、注册设置页（≈ main.ts，文件名由构建脚本固定）
    ├── api/dpet.ts              接口请求（≈ axios 封装）
    ├── store/dpet.ts            状态与轮询（≈ Pinia store）
    ├── hooks/useImportFlow.ts   导入流程逻辑（≈ Vue 3 composable）
    ├── views/SettingsPage.tsx   设置页，只负责拼装下面的组件
    ├── components/
    │   ├── FloatingPet.tsx      悬浮桌宠
    │   ├── PetStage.tsx         按 2D/3D 选择渲染器的舞台
    │   ├── common/Switch.tsx    开关
    │   └── settings/            设置页的各个区块：预览舞台、信息卡、图鉴、导入确认、动作编排、位置外观、预告卡
    ├── engine/                  渲染引擎（与界面框架无关）
    │   ├── motion.ts            2D/3D 共用的程序化动作
    │   ├── jelly.ts             2D 果冻变形的计算
    │   ├── flat.ts              2D 渲染器（画布切片绘制、透视倾斜、影子）
    │   └── gltf.ts              3D 渲染器（three.js，含接触阴影）
    ├── utils/                   气泡位置、状态文案、导入报告等小工具
    ├── i18n/index.ts            中英文文案（≈ vue-i18n）
    └── styles/dpet.module.css   样式（使用 DSH 的设计变量）
```

测试文件（`*.test.ts`）放在被测文件旁边；`tests/` 里是启动真实 HTTP 服务的接口集成测试。

## 许可证

代码使用 [Apache-2.0](LICENSE)。第三方组件与素材的说明见 [NOTICE](NOTICE)。

**东东的形象不适用代码许可证**：它归大连东软信息学院所有，只作为非商业的学生作品展示，详见 `assets/pets/dongdong/NOTICE.md`。
