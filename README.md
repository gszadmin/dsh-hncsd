# 元婴识海（dsh-hncsd）

把本地根目录下的每个一级子目录映射成识海中的一颗星云光点。点光点看名称、规范化路径、递归目录数、会话数。

> 显示名是「元婴识海」。npm 包名与客户端模块 id 都是 `dsh-hncsd`；row id `brain-workspaces` / slot key `brain-workspaces` / 路由 `/plugins/dsh-brain-workspaces/api/scan` / 存储键 `dsh-brain-workspaces:*` 均不变，改名不迁移数据。

- 入口：左侧栏的面板图标「元婴识海」→ 中间主面板。
- 首版不做：文件内容读取、全文搜索、Git 状态、3D、拖动、重命名、打开工作区。

## 安装与验证

安装只经 DSH 的插件管理工具完成，不手写 profile 里的 `cordis.patch.yml`。`plugin_manager` 是 DSH 的插件管理**工具**，不是终端命令（PowerShell、npm、pnpm 里都没有这个命令）；`install_bundle` 是它的动作名，`target = …` 是它的参数。

**方式一：从本仓库按固定 commit 安装**

```text
plugin_manager install_bundle  target = github:gszadmin/dsh-hncsd#<commit-sha>
```

- `<commit-sha>` 是占位符，不能照抄：请在本仓库的提交记录里复制某个 commit 的完整 40 位十六进制 SHA 替换它。
- 固定 commit 而不是写分支名：分支会前进，同一条命令以后装到的可能是另一份代码。
- 本仓库目前尚未发布 Release，没有 tgz 下载地址可给；请用方式一或方式二安装。
- 若当前 DSH 版本报「无法解析该 target」（不支持 git 源），改用方式二。

**方式二：从本地目录安装**

```text
plugin_manager install_bundle  target = 本仓库根目录的绝对路径
```

- 先把仓库 clone 到本地，`target` 填该目录的绝对路径。
- 适合改完代码就地验证：改完重载插件即可，不用重装。

### 补充说明

- 目标环境：DSH desktop profile（实测 `0.2.2-rc.1`）+ Node ≥ 20.19；Web 载体通用。
- 示例数据与 JSON Schema 只在开发工作区（`examples/`、`contracts/`），不随本仓库发布。
- 变更记录：[CHANGELOG.md](CHANGELOG.md)。

## 视角与外观

- **相机**：拖拽空白区域旋转（pitch 夹在 ±1.15 弧度），滚轮或右下 `−`/`+` 缩放（0.55×~4.5×），`⟲` 或双击复位。视角、缩放、主题、强调色与自动旋转开关都存本地，重开面板后保持。
- **取景框架**：轨道环 / 底座双环 / 垂直光束是 HUD，**不随旋转**（`stageFor(width, height, zoom)` 结构上拿不到 yaw/pitch）。缩放时只按 35% 的阻尼系数轻微扩张（0.82×~1.85× 钳制），避免放大后云团整个溢出框外。
- **聚焦**：点击任意珠子，镜头在 420ms 内平滑推近并把该珠子移到画布中心（easeOutCubic）。开始拖拽会立刻取消聚焦、并停掉自动旋转。
- **自动旋转**：`▶` 开启缓慢环绕（约 0.013 rad/s），`⏸` 暂停；一旦开始拖拽会自动暂停，避免两个来源同时改 yaw。它只转动相机，不改任何点的空间位置。
- **主题**：`nebula`（紫金）、`aurora`（青蓝）、`magma`（橙红）、`mono`（冷白）。主题只改氛围色与色带两端，不改变「颜色=目录数、大小=会话数」的语义。
- **强调色**：色取器覆盖色带的高端颜色（低端保持主题值），用于让"目录多"的珠子更醒目。
- **缩放 LOD**：`zoom ≥ 1.55` 或工作区 ≤ 14 个时，珠子旁显示名称；选中/悬停/键盘聚焦的珠子永远显示名称。名称用描边文字画在 canvas 上，不额外增加 DOM。
- **动效**：左下 `◍` 是**总开关**（默认开，遵守 `prefers-reduced-motion`），一次控制三件慢动作：
  - **呼吸**：云整体以 0.5Hz 做 ±0.9% 的均匀胀缩（canvas 变换，不重投影）；
  - **涟漪**：海面三圈椭圆向外扩散并淡出，相位互相错开；
  - **思绪**：5 条路径沿**真实纤维链**（4~7 段）跨半球行进，头部亮、带拖尾。
  - 三者都只依赖同一个动画时钟；动效关 + 不旋转时，rAF 循环完全停止。
- **信号脉冲**：7 天窗口内按活跃度排名前 30% 的工作区，会沿最近两条云边流出光点，并带四射星芒（同为动效开关管辖）。
  - 为什么用排名而不是绝对阈值：多个目录在同一小时内被改动时，线性归一化会把除最大值以外的全部压到 0，看起来像"什么都没发生"。排名没有这个问题。
  - 活跃度是 `max(目录 mtime, 最近新建会话)`。持久化层没有"会话活动时间"，我们不读 event log 去编造，所以状态栏文案统一是「最近活动」而不是「最近对话」。
  - 脉冲与自动旋转共用一个 rAF 循环；两者都关闭时循环完全停止，静态星图不耗 CPU。

## 渲染器

识海有两种可互换皮肤，共用同一份**已投影**的 scene，所以换渲染器不会移动任何珠子，`hitTest` 与 DOM 按钮永远指向同一点。

| 渲染器 | 实现 | 何时使用 |
|---|---|---|
| `canvas` | Canvas 2D（原有实现，行为逐像素不变） | 手动选择，或 three 不可用时自动回退 |
| `three` | three.js r160 + WebGL 2，按屏幕坐标绘制 Sprite/LineSegments/Points | `auto` 下 WebGL 2 可用且初始化成功 |

接口（`contracts/renderer.d.ts`）：`kind` · `mount(container, props)` · `update({ scene, clock })` · `resize(w, h, dpr)` · `hitTest(x, y)` · `destroy()`。`update` 把 `clock` 与 `scene` 分开传：动画时 scene 身份不变，渲染器**不会每帧重建几何**。

### three.js 的加载方式（不内联）

- **同级 chunk**：`client.three.js`（= `three@0.160.1` 的 `build/three.module.min.js`，未修改，655 KB）与 `client.js` 放在同一目录，由 Host 的 chunk 路由按需提供。
- **rev 来源（按优先级）**：
  1. 本插件自己的 Host 路由 `GET /plugins/dsh-brain-workspaces/api/chunk-rev`（与扫描路由同样受连接准入 + 同源校验），返回 Host 此刻认可的 rev —— **这是首选**，因为它永远是实时的；
  2. `window.__DSH_BOOT__.entries[].rev`（`readOwnRowRev()` 封装）—— 仅作兜底。boot 清单是**页面加载时的快照**，插件更新后不刷新页面它就是过期的（这正是 2026-11-14 首次装机出现 `HTTP 404` 的原因）。
- **自动重试**：某个 rev 拿到 404 时会自动换下一个候选 rev 重试，全部失败才降级。
- **不进主包**：主 bundle 仍是 ~143 KB，Three 只在真正切到 three 渲染器时下载。
- **降级**：`boot` 缺失 / `rev` 缺失 / HTTP 非 200 / 返回非 JavaScript（常见于落到 SPA 兜底）/ `import()` 失败 / 命名空间不是 three / 初始化抛错 / WebGL 上下文丢失 —— 全部回退 Canvas 并在画布左下角显示一句原因，**不会白屏**。
- **缓存**：chunk 按 `client.js` 派生的 rev 做 immutable 缓存。**只替换 `client.three.js` 而不改 `client.js` 时，浏览器可能继续用旧 chunk**；更新 Three 后请顺手触碰 `client.js`。
- **更新插件后建议刷新一次页面**：rev 现在能自动纠正，但页面里的旧模块实例仍会继续运行，刷新可让所有模块都换到新代。
- **许可证**：MIT，full text 见 `THIRD_PARTY_NOTICES.md`。Three 未做任何代码修改，仅作为独立 chunk 分发。

### Three 版实现范围

| 项 | 实现 |
|---|---|
| 场景与相机 | `THREE.Scene` + `OrthographicCamera(0, w, 0, h)`：**y 向下的正交投影**，1 单位 = 1 CSS 像素，与屏幕坐标同向 |
| 渲染器 | `THREE.WebGLRenderer` 绑定**显式创建的 `webgl2` context**；拿不到 context 就抛错并按降级链回退 Canvas |
| 半球色雾 | 一个全屏 quad + 片元着色器（左金 / 右紫两团高斯 + 暗角）。**无纹理、无后处理**；`renderOrder 0`、`depthWrite:false`，不遮挡光点 |
| 脑区轮廓 | `scene.hull` 画**双层闭环线**（外轮廓 0.34、内缩 4.5% 的辅线 0.12）+ 一条中缝线，几何边界仍来自 `BRAIN_SHAPE` |
| 工作区 | **单个 `THREE.Points` + 单个 `BufferGeometry`**：逐点 `position / aColor / aSize / aAlpha / aPhase`，自定义着色器把方形点精灵画成径向光晕 |
| 深度 | `bead.depth` **只调制尺寸（×1+0.35d）与亮度（×0.75+0.25d）**，绝不移动 position —— 命中与 DOM 按钮始终对齐 |
| 呼吸 | 每点相位由 `hashId(工作区 id)` 推导（无随机数），只调制尺寸 ±6% 与透明度 ±10%；整云另有 ±0.9% 缩放 |
| 选中 / 悬停 | 批量内尺寸 ×1.9（选中）/ ×1.35（悬停）+ 独立白环（选中 0.9、悬停 0.45 不透明） |
| 纤维 | 单个 `LineSegments`；按强度取前 `maxConnectionCount` 条（确定性截断）。**不含工作区之间的连线** |
| 活动脉冲 | 单个 `Points`（头部）+ 单个 `LineSegments`（拖尾），只来自 `scene.pulses`（真实活动数据）；无活动数据时**不创建**；上限 `maxPulseCount` |
| 动画循环 | 渲染器自持 rAF，`targetFps` 节流；关掉动效后只在脏标记时重绘；`destroy` 取消帧 |

**调参（代码常量 `THREE_TUNING`，不进 Host 配置）**

| 键 | 默认 | 作用 |
|---|---|---|
| `maxDevicePixelRatio` | 2 | `devicePixelRatio` 上限；DPR 走 uniform，resize 不重建几何 |
| `animationEnabled` | true | 动效总开关；`prefers-reduced-motion` 或关掉 `◍` 时强制关闭 |
| `maxPulseCount` | 24 | 脉冲批次顶点上限 |
| `maxConnectionCount` | 900 | 纤维线段上限（按强度截断，确定性） |
| `targetFps` | 30 | 内循环帧率上限 |
| `hazeEnabled` | true | 低端 GPU 可关掉全屏色雾 |

已知差异：Three 版不承诺与 Canvas 像素一致。它保证**同一批珠子、同一批纤维、同一套命中坐标、同一套交互语义**。

### 脑组织与沟回（0.6.0）

画面的主体是**脑组织**，工作区光点是信息入口，纤维与云点降为纹理。结构由两个渲染器共享，但绘制方式不同：**Three 是主渲染器，Canvas 只做必要兜底**。

| 层 | 结构来源 | Three（主） | Canvas（兜底） |
|---|---|---|---|
| 半球填充 | `scene.tissue.halves`（由 `BRAIN_SHAPE.outline` 按中缝切分） | 质心扇形三角化 + 主题色（左金 / 右紫） | 线性渐变填充，左右同色相 |
| 厚度缘 | `tissue.rim`（轮廓 ×1.015） | 一条闭合描边 | 兜底不画 |
| 内缩轮廓 | `tissue.contours`（0.94 / 0.88） | 两条闭合描边 | 两条闭合描边 |
| 脑沟回 | `tissue.sulci`：每半球 6 主沟 + 12 次沟，左算右镜像 | 每半球一个 `LineSegments`（主+次） | 只画主沟（兜底保持简单） |
| 中缝 | `tissue.seam`（竖直直线） | 一条 Line | 一条 stroke |

**确定性**：`buildBrainTissue(shape)` 是纯函数，控制点来自固定表 `SULCUS_TABLE`（6 条，弧长比例 0.10~0.88），没有随机数、没有每帧变化；右半球是左半球按中缝的**严格镜像**（`x′ = 2cx − x`，测试逐点断言到 1e-9）。

**边界**：沟回点生成后做"越缝钳制"（左 x < cx、右 x > cx）并被拉回轮廓内（`insideWithMargin`），不会穿出脑形或穿过中缝。

**权重**（`TISSUE_STYLE`，两渲染器共用一份系数）：纤维 α ×0.5 / 线宽 ×0.8，云点尺寸 ×0.75 / α ×0.7，**工作区光点系数恒为 1**（`beadAlphaScale`，测试锁死）。

**点位不受影响**：`scene.tissue` 只是并列的视觉字段；`scene.beads[].x/y`、`pickBeadAt`、DOM 按钮坐标全都没有改动，`tests/regression-round3.test.mjs` 用黄金值钉死。

### 警告显示（0.5.1）

真实扫描里一条语义会被拆成上千条：`<你的根目录>`（33 个工作区）产出 **4493 条**警告，其中 **4492 条**是 `truncated-depth` —— 扫描器对**每个**处在深度上限的目录各发一条。面板按 `code + message` 归并后：

| 位置 | 归并前 | 归并后 |
|---|---|---|
| 详情卡（单个工作区） | 最多 790 行（`wangcang`） | 1 组 + `涉及 790 个目录` |
| 右栏汇总 | 4493 条塞进 40 行、全是同一句 | 2 组 |

每行附 `涉及 N 个目录`，悬停可看前 3 条原始路径；超过组数上限显示"还有 N 种"。**扫描器未改动** —— 警告仍在数据层产生，归并只发生在显示层。

## 编码约定（一个通道只承载一个语义）

| 视觉通道 | 编码什么 | 数据来源 |
|---|---|---|
| 珠子填充色（9 级，紫少 → 金多） | **目录数** | `fs.readdir` 递归计数 |
| 珠子大小（0.68× ~ 1.6×） | **会话数** | `sessionPersistence.list()` 的 `header.cwd` 归属 |
| 详情面板「最近新建会话」 | 该工作区内最新的 `header.createdAt` | 同一份快照；没有就不显示（不编造时间） |
| 流动脉冲 | **最近活动**：窗口内按活跃度排名前 30% 的工作区 | 活跃度 = `max(目录 mtime, 最近新建会话)` |
| 四射/八射星芒 | **会话数的强弱**（对数比例，锚定本次最大值） | `header.cwd` 归属的会话数 |
| 环的线型（实线/虚线/空心+点线） | 扫描状态 | 扫描器警告 |
| 半球染色 | 不编码任何数据（极淡氛围色） | artwork |

两个数值都用对数刻度归一，并各自以本次扫描的最大值作为锚点；画布底部有图例标出「≤ 最大值」。颜色与大小**不共用通道**，所以状态改走形状，详情面板同时给出文字状态与两个计数——不依赖颜色或大小单独传达信息。

进度条与「部分结果」徽标是面板 UI，不占用任何珠子通道：颜色仍是目录数、大小仍是会话数、线型仍是扫描状态。

## 数据通路（为什么扫描在 Host 侧）

```
页面（Client） --pickDirectory()--> Host 原生目录选择器
页面（Client） --GET /plugins/dsh-brain-workspaces/api/scan?root=…--> Host 只读扫描 --readdir--> 磁盘
```

关键取舍：本机组合的是 **native** 目录选择器，`uiWorkspace.listDirectory` 背后的 `directoryPicker.list` 需要 browse 能力，而组合里只有 native，所以那条 Remote 通路在这台机器上不可用（报 `directoryPicker/unavailable`）。因此目录列举改由本插件自己的 Host 半用 `node:fs` 完成，结果经一条同源只读路由交给页面——这也正是原设计文档 §4「Host: local-directory-source」的位置。

## 扫描进度与部分结果

同一条路由有两个面，用 `Accept` 协商，**不加 query 参数**（请求串仍只有 `root`）：

| 请求 | 响应 |
|---|---|
| `Accept: application/x-ndjson` | NDJSON 流：`start` → `warning`/`workspace`/`limit` → `done`（末行带完整快照） |
| 其它 / 不带 | 与旧版完全一致的单个 JSON 快照 |

- **进度**：`start` 行先给出分母（一级子目录数），之后每个 `workspace` 行带 `done/declared`、已访问目录数、耗时。面板把它画成一条细进度条（工作区进度填条），并在旁边标出「目录 4,120 / 20,000」「耗时 3.2s / 8.0s」。耗时由本地 500ms 时钟补算，单个超大工作区卡住几秒时也不会像死机。
- **部分结果**：每个工作区数完就上图，不等整轮结束。槽位在流式期间按到达顺序追加（已出现的光点不再移动），完成后把 assignments 持久化；之后同一根目录每次扫描都回到同一点位。
- **超限提示**：`limit` 行在预算命中的瞬间发出（`dirs` / `time` / `depth`，每种只发一次），面板立刻转琥珀/告警色并说明「已达目录上限 20,000，剩余工作区只列名不再计数 · 可在插件配置里调大 maxDirs / timeoutMs」。扫描结束后如结果不完整，顶部保留「部分结果」徽标和一条常驻说明。
- **取消**：已扫到的光点保留在界面上并标记为部分结果；**半截快照不写缓存**，刷新后回到上一次完整扫描。取消不发 `done`/`error`，客户端靠 `AbortError` 认。
- **兼容**：新 Client + 旧 Host → Host 回 JSON，客户端回落 `json()`；旧 Client + 新 Host → 旧 Client 不带这个 `Accept`，照旧拿 JSON。

## 术法蒸馏（工作区技能，0.7.0 / 0.8.0）

详情卡里那颗按钮不是渲染器的一部分：它只画 DOM 浮层，**three / canvas 两个渲染器的入参、场景与层级表都没有变化**。

```
详情卡「术法蒸馏」--> GET /plugins/dsh-brain-workspaces/api/skills[?workspace=<绝对路径>]
行内操作        --> POST /api/skills/distill | /trash | /globalize
```

页面自上而下三块：**可提升为全局的项目技能 → 原有五个指标 → 按工作区分区**（设计稿在维护者本地，不随本仓库发布）。

| 项 | 做法 |
|---|---|
| 触发 | 点按钮才查，不参与星云扫描；30 秒缓存（最多 8 份），`?refresh=1` 绕过缓存 |
| 复用次数口径 | 会话投影里 `{cat:'skill', tool:'skill', skill:<名字>}` 记一次真实加载；`record.identity.cwd` 决定它属于哪个工作区。与 `~/.dsh/tools/skill-usage/collect.mjs` 同一口径，数字可对帐 |
| 技能来源 | `<工作区>/.dsh/skills`、`<工作区>/.agents/skills` 为项目级；`~/.dsh/skills`、`~/.agents/skills` 为用户级；两者都没有但被加载过，标为「未找到文件」 |
| 提升判据 | 项目级 + 全局无同名；**按「工作区 + 名字 + 内容指纹」分行**，同名不同内容各自成行、互不算复用。状态只是提示：`project-specific`（正文命中路径/工作区名/`@local` 包/内网地址）、`portable`（无标识且有触发条件或步骤）、`needs-structure`（两者都没有）。**没有任何一条因为"加载够多"被推荐** |
| 证据与版本 | 加载次数、涉及工作区都是**历史记录、版本未知**（`evidenceVersion: 'unknown'`）：历史加载无法与当前内容指纹对应，面板如实标注，不用当前哈希追认 |
| 状态账本 | 加入全局成功后写 `<DSH_HOME>/skill-distill-scope.json`（名字 / 来源 / 加入时指纹 / 时间，幂等）；「已加入全局（记录）」显示加入时间、指纹与「内容已改动」；只有人工验证记录与当前指纹一致才显示「已验证通用」，本期没有任何写验证的入口 |
| 已忽略 | 落盘 `<DSH_HOME>/skill-distill-ignored.json`；A 区「查看已忽略 (N)」按钮常驻可见，清单是权威，匹配不到当前技能的条目标「当前已无对应技能」，可单条恢复 |
| 可删判据 | 加载次数 ≤ 1（`REMOVABLE_MAX_LOADS`） |
| 蒸馏 | 补 name、补/续 description，让文件变成模型能发现并加载的形状；原文件先备份到 `<工作区>/.dsh/skills-versions/<name>/`，已合规时不写盘（幂等） |
| 删除 | 两步确认；整目录移到 `<工作区>/.dsh/skills-trash/<时间戳>-<name>/`，可人工搬回，不是真删 |
| 加入全局 | 复制到 `~/.dsh/skills/<name>`，保留原副本；同名已存在返回 409，绝不覆盖；`project-specific` 行需要二次确认（提示不是禁令，仍可手动加入） |
| 只读边界 | 三个写动作都要 POST + 准入 + 同源；`?workspace=` 只影响排序，不影响统计 |

字段说明：`buildSkillsPayload` 是纯函数（`skills-local/report.js`），聚合、分行、状态、依据、未使用清单都在它身上并有测试钉住；`skills-local/portability.js` 是内容指纹与项目标识 lint（纯函数、无模型调用）；`collectSkillsReport` 只负责读盘；`skills-local/actions.js` 负责三个写动作与状态账本，路径穿越与非 kebab-case 名字一律拒绝。

## 隐私与安全边界

| 边界 | 实现 |
|---|---|
| 不读用户内容 | 扫描器只用 `fs.readdir(withFileTypes)` / `stat`，从不 open 用户文件；术法蒸馏只读技能目录里的 `SKILL.md`（用于 frontmatter、内容指纹与项目标识提示），不读会话正文、提示词或标题 |
| 写用户目录的范围 | 只写 `<DSH_HOME>/skill-distill-ignored.json` 与 `<DSH_HOME>/skill-distill-scope.json`（几 KB，原子写，坏文件不影响页面），以及浏览器 `localStorage` 里的设置与槽位表；工作区文件只在用户点「蒸馏 / 删除」时动，且先把原文备份到 `.dsh/skills-versions`；用户点「加入全局」时复制到 `<DSH_HOME>/skills/<name>`（同名已存在返回 409，绝不覆盖） |
| 不联网 | 无对外请求；页面只做同源 GET |
| 路由需授权 | 必须通过 `ctx.connection.requestRejection(req)` 准入，且拒绝跨源 `Origin` |
| 只接受绝对路径 | 相对路径返回 400；盘符根、系统目录、网络共享根一律拒绝 |
| 不跟随符号链接 | `isSymbolicLink()` 的条目直接跳过（比 browse 后端更严格） |
| 路径不外泄 | id 是规范化路径的大小写不敏感哈希（16 位 hex），路径只在本地面板渲染 |
| 预算兜底 | 最大深度 5、目录访问上限 20000、单次超时 8s；超限即时提示并标注「部分统计」 |

## 配置

`cordis.patch.yml` 的 row `config`（Host 在 `apply()` 中校验、钳制并合并默认值；路由按请求参数覆盖）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `''`（空串 = 未配置） | 预留的快照/槽位目录，运行期暂未使用；需要时填绝对路径 |
| `maxDepth` | 5 | 单工作区最大递归深度（钳制 1~32） |
| `maxDirs` | 20000 | 单次扫描目录访问上限（路由侧下限 100，上限 200000） |
| `timeoutMs` | 8000 | 单次扫描总时长上限（钳制 250~30000） |
| `includeHidden` | false | 是否纳入隐藏目录 |
| `ignoreNames` | `.git node_modules dist build .cache .venv vendor` | 顶层与内部都不计入目录数 |
| `allowRoots` | `[]` | 预留的额外允许根白名单 |

## 关键实现决策

1. **点位稳定性靠持久化的槽位表**。`layout(nodes, shape, { assignments })` 是纯函数：节点保持已有槽位，新节点取最小空闲槽位（删除留下的空位会被优先回填）。刷新、目录数变化都不移动点位。
2. **轮廓与包含判定共用同一个多边形**（`BRAIN_SHAPE.outline`）：画出来的形状与「点必须在内」的判定不会漂移。
3. **跨层级最小间距**：层 1 稀疏铺满大脑，层 3/5/7/9 逐级细分；不同层级的栅格会交错（实测有一对点只差 4.27px），所以每个候选槽位必须与所有已接受槽位保持 ≥0.75×当前间距。
4. **`client.js` 单文件**：浏览器模块加载器不支持包内相对 `require`，因此 `source-local/guards.js` 是边界规则的权威实现，`client.js` 内保留一份展示用副本，`tests/parity.test.mjs` 用同一批输入锁死两者一致。
5. **渲染是"canvas 艺术画布 + 数据珠点"两层**。大脑区用一个 `<canvas>`：固定相机（yaw −0.16 / pitch −0.34）+ 手写透视除法投影，按深度排序绘制发光珠点（径向渐变 sprite 缓存），深色背景与纤维网属于 artwork。相机**从不自动移动**，深度偏移由槽位号经 `mulberry32` 确定性派生，因此同一输入的画面逐像素稳定、刷新不变。可访问性不靠 canvas：珠点上方叠了一层随投影定位的透明按钮，`Tab`/`Enter`/`aria-label` 照常可用。字面色仅限这块画布，周边控件仍全部使用 `--dsw-alias-*`。


## 测试

测试与夹具不随本仓库发布，在开发工作区（`packages/dsh-brain-workspaces`）运行：

```powershell
cd packages/dsh-brain-workspaces
node --test tests/
```

402 条，覆盖：路径规范化、id 稳定性与不泄露、忽略/隐藏策略、过宽根、containment、布局确定性与越界、500 节点不重叠、删除留空位/新增回填、Host 扫描计数、深度与数量截断、权限错误降级、符号链接不跟随、取消、路由准入与跨源拒绝、路由错误码、HTTP 扫描器失败语义、两份守卫实现一致性、存储配额降级；以及本轮新增的流式事件（`start`/`workspace`/`limit`/`done` 顺序与契约、预算命中只发一次、背压 drain、中途断开无收尾、`Accept` 协商与错误码不被流吞）、客户端 NDJSON 解析（跨块拼接、坏行忽略、断流/取消/错误行语义、老 Host 回落）、进度归约（去重、部分结果判定）、进度与超限文案与真实元素渲染（中英）。

## 已知限制

- **取消后不续扫**：取消即止，已扫结果留在界面但不写缓存；再扫是重新开始。
- **不做聚簇**：节点极多时靠搜索与悬停定位，不合并语义。
- **忽略名单只读**：首版不可在 UI 中编辑。
- **`dataDir` 尚未使用**：快照仍存在 `localStorage`（KB 级），Host 侧快照缓存留给后续版本。

## 许可证

MIT
