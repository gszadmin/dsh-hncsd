# 变更记录

## 0.10.0 — 2026-11-22

让「推荐成为全局」可信：热度不再等于通用性，同名不再等于同内容（设计稿 `docs/specs/2026-11-22-skill-recommendation-trust.md`）。

- **删掉「加载够多就推荐全局」**：`RECOMMEND_MIN_LOADS` / `RECOMMEND_MIN_WORKSPACES` 两个阈值常量与 `recommended` 字段一起移除。A 区改名「可提升为全局的项目技能」，排序先看有没有项目标识、再看热度，没有任何一条因"够热"被抬成推荐。
- **内容指纹 + 按内容分行**：新增 `skills-local/portability.js` 的 `contentHash`（sha256 前 16 位）；候选按「工作区 + 名字 + 指纹」分行，同名不同内容不再被合并成「跨工作区复用」。
- **项目标识 lint（只作提示）**：`lintPortability` 用确定性正则指出正文里的 Windows 路径、工作区名、`@local` 包名、内网地址与本机端口，附原文片段；`project-specific` 仍可手动加入全局，按钮改为二次确认。
- **版本不追认**：加载次数与涉及工作区一律标「历史记录，版本未知」（`evidenceVersion: 'unknown'`），不用当前指纹倒推历史加载的版本。
- **状态账本** `<DSH_HOME>/skill-distill-scope.json`：加入全局成功后记录名字 / 来源 / 加入时指纹 / 时间（来源做路径归一化，尾分隔符、正斜杠、大小写都收敛成同一条，幂等）；面板新增「已加入全局（记录）」，显示加入时间、指纹、「内容已改动」；只有与当前指纹一致的人工验证记录才显示「已验证通用」，本期没有任何写验证的入口。账本文件损坏时 A 区明说「状态账本不可读」，不再静默消失。
- **已忽略可见**：A 区入口由折叠 `<details>` 改成常驻按钮「查看已忽略 (N)」；忽略清单成为权威来源，匹配不到当前技能的条目标「当前已无对应技能」，仍可单条恢复。
- 清理：删掉从未渲染过的死键 `skillsReused`（「跨工作区复用」在 HEAD 起就没有渲染点，避免文档与实际不一致）；README 隐私表补上两个 `<DSH_HOME>` 账本文件，并把「不读用户内容」写清为只读 `SKILL.md`。
- 测试：新增 `skills-portability.test.mjs`（8 条），report +5 / actions +1 / overlay +3，另把 globalize 路由改成端到端验证账本与报表；全量 **399** 条通过。

## 0.9.1 — 2026-11-20

- 修筛选条的下拉看不清：原生 `<select>` 的弹层不吃继承色，暗色主题下是白底白字。现在 `<select>` 与每个 `<option>` 都显式给 `--dsw-alias-bg-layer-1` 背景 + `--dsw-alias-label-primary` 文字色，浅色主题同样成立。
- 搜索框背景由 `transparent` 改为 `surfaceRaised`，不再叠在星云上发花。

## 0.9.0 — 2026-11-19

三件一直挂着的事一起做完：忽略持久化、删除级联清账本、筛选维度。

- **忽略持久化**：`POST /api/skills/ignore` 与 `/unignore` 把候选写进 `<DSH_HOME>/skill-distill-ignored.json`（按 `工作区 + 技能名` 去重，重复忽略幂等）。被忽略的候选从 A 区移入可折叠的「已忽略的候选 (N)」，可一键恢复；报表新增 `ignoredPromotions` 字段。
- **删除级联清 mnemon 账本**：`trashSkill` 接受 `mnemonRoot`，删除后调用 `cascadeLedger` —— 只删该技能的 `suggestions` / `drafts` / `versions`（按 `skillName` 与 `skillKey` 尾段匹配），**复盘记录与对话轨迹保留**；账本写盘前先落一份 `ledger.backup-<时间戳>.json`，删除结果里带回 `ledger.removed` 计数。
- **筛选维度**：面板新增筛选条 —— 关键词（技能名 / 工作区名 / 描述）、来源（全部 / 项目级 / 用户级）、工作区下拉、只看未使用；全部在前端过滤，不额外打接口；筛空时给明确空态。
- 测试：+5 条（忽略清单落盘与恢复、级联清理与备份、报表忽略过滤、忽略/恢复路由、删除级联路由），全量 372 条通过。

## 0.8.1 — 2026-11-19

- **A 区从「只显示够热的推荐」改成「列出所有可提升为全局的项目级技能」**：新增 `promotable`（项目级 + 全局目录无同名，同名跨工作区合并），其中够热/够广的打「推荐」标。默认摆 6 个，其余折叠成「展开全部 N 个」——「加入全局」之前先能看清到底有哪些。
- 每行新增 **预览**：`GET /api/skills/preview?workspace=&name=` 只读返回 SKILL.md 前 8KB（可 `limit` 调整，硬顶 64KB），面板里就地展开原文；再点一次收起。
- 测试：+2 条（promotable 聚合、预览路由含 404 与路径穿越拦截），全量 367 条通过。

## 0.8.0 — 2026-11-19

第五轮：术法蒸馏从「一块只读面板」长成「一页能动手的管理页」。渲染器仍然零改动。

- 页面结构按设计稿重排：**A 推荐成为全局可用的技能 → B 原有五个指标 → C 按工作区分区**（见 `docs/specs/2026-11-19-skill-management-page.md`）。
- 指标条按原口径补了两个之前缺的字段：`totals.usedSkills`（只数至少被加载过一次的技能，与技能总数不同）与 `totals.sessionsWithSkill`（按会话文件去重的「用过技能的会话」）。五个卡片即：加载总次数 / 被用过的不同技能 / 有技能加载的工作区 / 用过技能的会话 / 自进化累计建议。
- 新增 `recommended`：项目级技能满足「加载 ≥ 5 次」或「跨 ≥ 2 个工作区」且全局目录无同名时进入推荐；同名多处合并，保留加载次数最高的一条。
- 新增 `removable`：加载次数 ≤ 1 的技能才显示删除入口（阈值集中在 `skills-local/actions.js`）。
- 每行技能新增两个动作：
  - **蒸馏**：把 SKILL.md 规范化成模型能发现并加载的形状（补 name、补/续 description），原文件先备份到 `<工作区>/.dsh/skills-versions/<name>/`，幂等（已合规时不写盘）。
  - **删除**：两步确认后整目录移到 `<工作区>/.dsh/skills-trash/<时间戳>-<name>/`，不是真删。
- 推荐行新增 **加入全局**：复制到 `~/.dsh/skills/<name>`，保留原副本；目标同名已存在时 409，绝不覆盖。
- 三个写动作各一条 POST 路由（`/api/skills/distill|trash|globalize`），全部过准入 + 同源检查，成功后清空报表缓存；`?refresh=1` 可绕过 30 秒缓存。
- 工作区卡片把「0 次加载的项目级技能」独立到 C3 子块，主列表只留有使用记录的，同一行不再出现两次。
- 测试：+17 条（动作 9、路由动作 5、聚合 recommended/removable 2、浮层推荐区与行内操作 1），全量 365 条通过。

## 0.7.0 — 2026-11-19

第四轮前半：术法蒸馏（工作区技能）。**只加只读查询与一个 DOM 浮层** —— three/canvas 两个渲染器、扫描、稳定布局、命中与 DOM 按钮层、主题、持久化全部零改动。

- 详情卡新增入口按钮「术法蒸馏」：点开是一个覆盖面板的 DOM 浮层，列出各工作区沉淀的技能与真实加载次数。
- 新增只读路由 `GET /plugins/dsh-brain-workspaces/api/skills`：`?workspace=<绝对路径>` 只影响排序（该工作区排最前并标 `selected`）；30 秒缓存，最多留 8 份。
- 数据来源：会话投影 `storages/session_projcache/sessions/*.json` 里 `{cat:'skill', tool:'skill', skill:<名字>}` 的真实加载记录 + 四类技能目录（`<工作区>/.dsh/skills`、`<工作区>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`）+ mnemon 账本计数。只读，不写技能、不改账本。
- 面板内容：四个数字（工作区 / 技能 / 复用次数 / 跨工作区复用）、**每个工作区一张可折叠卡**（`<details>`，默认只展开被点开的工作区或复用最多的那个，其余收起成一行「N 技能 · M 次 · K 会话」）、可折叠的「沉淀了但还没用过」、底部自进化计数；页头另有「全部展开 / 全部收起」。
- 入口两处：页头常驻按钮（不选光点也能开）+ 详情卡按钮（打开时把当前光点排最前）。
- 新模块 `skills-local/report.js`：`buildSkillsPayload` 是纯函数（聚合与排序都在它身上），`collectSkillsReport` 负责读盘；`parseSkillFrontmatter` 处理 frontmatter 与缩进续行。
- 测试：+15 条（聚合与 frontmatter 7 条；浮层渲染 4 条 —— 用 `contracts/load-client.mjs` 的 React 桩渲染真正装载的组件，断言工作区、`17 次 · 9 会话`、`从未使用`、`当前光点`、失败可重试、`apply` 仍只注册两处；路由 4 条 —— 临时 DSH_HOME + 临时 mnemon 根走真 handler，断言 catalog 噪音不计入、`?workspace=` 只改排序、403/405 鉴权、缓存命中）。`host-route.test.mjs` 的路由数由 2 改为 3。全量 346 条通过。
- 口径与 `~/.dsh/tools/skill-usage/collect.mjs` 完全一致，两处数字可互相对帐。

## 0.6.0 — 2026-11-14

第三轮：脑组织与脑沟回。只做视觉结构 —— 扫描、数据模型、稳定布局、搜索、详情、键盘交互、DOM 按钮层、降级链零改动。

- 新增纯结构 `buildBrainTissue(shape)`：半球填充（按中缝切分）、厚度缘（×1.015）、两层内缩轮廓（0.94 / 0.88）、每半球 6 主沟 + 12 次沟、竖直中缝。固定参数表 `SULCUS_TABLE`，无随机数。
- 右半球为左半球**严格镜像**（`x′ = 2cx − x`，逐点断言 1e-9）；沟回点做越缝钳制并拉回轮廓内。
- `scene.tissue` 为**可选**视觉字段（`RendererScene.tissue?`），不进入扫描/布局/持久化/业务模型；缺失时两个渲染器都不受影响。
- Three（主渲染器）：2 个半球填充 Mesh + 厚度缘 + 双层内缩轮廓 + 每半球一个沟回 `LineSegments` + 中缝；统一 `ORDER` 层级表（组织 < 纤维 < 云点 < 光点 < 选中环 < 脉冲）。
- **修 Three 纤维退化**：`buildLinks()` 原来只画端点直线，现按 `link.cx/cy` 采样二次曲线（8 段），与 Canvas 的 `quadraticCurveTo` 同曲线。
- Canvas（兜底）：半球填充、左右色差、中缝、主沟回；不做厚度缘与次沟，保持兜底简单。
- 权重下调：`TISSUE_STYLE` 中纤维 α ×0.5 / 线宽 ×0.8、云点 ×0.75 / α ×0.7；工作区光点系数恒为 1。
- 修复：`centroidOf()` 返回数组 `[x, y]`（非 `{x, y}`），首次实现误用导致沟回坐标全为 NaN 被过滤为空 —— 已修正并用测试锁住。
- 测试：+23 条（结构 11、Canvas 兜底 5、回归黄金值 4、Three 组织/层级/曲线 3）。

## 0.5.1 — 2026-11-14

- 修警告刷屏：真实扫描（33 个工作区）产出 4493 条警告，其中 4492 条是同一种 `truncated-depth`（扫描器按目录逐条发出），详情卡会把它们逐行铺满。
- 显示层按 `code + message` 归并：详情卡最多 4 组、右栏汇总最多 6 组；每组显示 `涉及 N 个目录`，`title` 给出前 3 条原始路径，超出显示"还有 N 种"。
- 实测效果：`wangcang` 790 行 → 1 行；右栏 4493 条 → 2 组。
- 新增纯函数 `groupWarnings(warnings, limit)`，7 条断言（归并 / 顺序 / 样本路径 / 上限 / 4493 条真实规模 / 异常输入 / 空 code）。
- **扫描器未改动**（`source-local/scan-host.js` 零改动），仅改显示层。

## 0.5.0 — 2026-11-14

第二轮：Three.js 视觉增强。扫描、数据模型、稳定布局、搜索、详情、键盘交互、Canvas 渲染与降级链**零改动**。

- 半球色雾：一个全屏 quad + 片元着色器（左右两团高斯 + 暗角），无纹理、无 Bloom/SSR/阴影/PBR；`renderOrder 0`、`depthWrite:false`，不遮挡光点。
- 脑区轮廓：`scene.hull` 双层闭环线 + 中缝线。
- 深度：`bead.depth` 只映射到尺寸与亮度，position 不变，命中与 DOM 按钮保持对齐。
- 确定性呼吸：每点相位来自 `hashId(工作区 id)`；修复 `hashId` 返回 16 位十六进制字符串被当作数字取模的 bug。
- 活动脉冲：单个 `Points` + 单个 `LineSegments`；仅来自真实活动数据；无数据时不创建；上限 `maxPulseCount`；受 `animationEnabled` / `prefers-reduced-motion` / `◍` 三重闸门。
- 纤维：按强度确定性截断到 `maxConnectionCount`（默认 900）。
- 修 DPR 单位：`gl_PointSize` 走 `uDpr` uniform（设备像素），3x 屏钳到 2；resize 不再重建几何。
- 新增 `THREE_TUNING` 代码常量（maxDevicePixelRatio / animationEnabled / maxPulseCount / maxConnectionCount / targetFps / hazeEnabled）。
- `prefers-reduced-motion` 记忆化，避免每帧 matchMedia。

## 0.4.0 — 2026-11-14

### 渲染器抽象

- 新增 `BrainRenderer` 接口（`contracts/renderer.d.ts`）：`kind / mount / update({scene,clock}) / resize / hitTest / destroy`。
- Canvas 2D 抽成 `createCanvasRenderer()`，行为逐像素不变；`hitTest` 与可访问 DOM 按钮共用同一份已投影 scene 的 `pickBeadAt()`。
- 新增 `createThreeRenderer()`（three.js r160），第一轮为最小实现：`THREE.Scene` + y 向下正交相机（1 单位 = 1 CSS 像素）+ `WebGLRenderer` 绑定**显式 `webgl2` context**；
  脑区轮廓画成**线框闭环**；所有工作区用**单个 `THREE.Points` + 单个 `BufferGeometry`** 批量渲染（逐点颜色/大小/透明度 + 自定义着色器光晕），选中节点尺寸 ×1.9 并带独立选中环；
  渲染器**自持 rAF 循环**，仅脏标记时重绘。因按屏幕坐标绘制，换皮肤不会移动任何珠子。
- 渲染器选择写入 view settings（`auto` / `canvas` / `three`），默认 `auto`：WebGL 2 可用且 three 初始化成功才用 Three。
- 降级链：boot 缺失 / rev 缺失 / HTTP 非 200 / 非 JS 响应 / `import()` 失败 / 命名空间不是 three / 初始化抛错 / WebGL 上下文丢失 → 回退 Canvas 并在画布左下角说明原因，不白屏。
- 动画只更新 clock，不重建几何；`destroy()` 释放 canvas、监听器、几何、材质与 `WebGLRenderer`，可重复调用。

### 修复：Three 版黑屏（装机实测发现）

- 根因：几何点 y 取负，而相机是 y 向上（`top=height, bottom=0`）的传统正交投影 → 整个场景落在视野外，只剩清屏色。
- 修法：相机改为 y 向下的正交投影（`top=0, bottom=height`），几何直接使用屏幕坐标；呼吸缩放中心相应调整。
- 回归测试：断言相机参数为 `[0, w, 0, h]`、珠子 y 等于屏幕坐标、所有顶点落在视野内。

### 修复：chunk 请求 404（装机实测发现）

- 根因：首次实现用 `window.__DSH_BOOT__.entries[].rev` 作为唯一 rev 来源。boot 清单是**页面加载快照**，改完插件只做 toggle 而不刷新页面时，页面里的 rev 已过期，chunk 路由按当前文件算出新 rev → 404 → 降级 Canvas。
- 修法：新增 Host 路由 `GET /plugins/dsh-brain-workspaces/api/chunk-rev`（连接准入 + 同源校验，`cache-control: no-store`），实时返回 Host 认可的 rev（算法与 Host 的 `artifactRevision` 完全一致）；客户端优先问它，boot rev 只作兜底；任一 rev 404 时自动换下一个候选重试。
- 测试：新增 3 条（fetchLiveRev 的四种坏响应、live→boot 的自动回退、两个 rev 全 404 时返回 `http-404`）。

### Three.js 接入（P-C：独立同级 chunk，不内联）

- 内置 `client.three.js`（`three@0.160.1` 的 `build/three.module.min.js`，655 KB，未修改），主 bundle 体积不变。
- 按需加载 `/plugins/<pkg>/client.three.js?rev=<本包 rev>`；`rev` 取自 `window.__DSH_BOOT__`，封装在 `readOwnRowRev()`，取不到即回退。
- 新增 `THIRD_PARTY_NOTICES.md`（three.js MIT 全文）。
- 注意：chunk 按 `client.js` 派生的 rev 缓存，替换 chunk 时需同时触碰 `client.js`。

## 0.3.0 — 2026-11-13

### 扫描进度（同路由流式，`Accept` 协商）

- 扫描路由支持 `Accept: application/x-ndjson`：`start` → `warning`/`workspace`/`limit` → `done`，逐行事件，末行是完整快照。不带这个 `Accept` 时仍返回原来的单个 JSON，老客户端与老测试零改动；查询串依旧只允许 `root`。
- Host 扫描器新增 `onEvent`（保留 `onProgress`）：`start` 给出分母，每个工作区数完立刻发 `workspace`（含该工作区的告警），预算首次命中发一次 `limit`，监听器抛错不会中断扫描。
- 路由写出带背压（`drain` 排队）与终止保护（`writableEnded`/`destroyed` 后不再写）；客户端断开即取消，不发 `done`/`error`。
- 快照新增可选 `scan` 汇总：`declared / scanned / visitedDirs / maxDirs / maxDepth / timeoutMs / elapsedMs / partial / limits{dirs,time,depth}`。缺这个字段的旧缓存照旧可用（表示"汇总未知"，不升存储版本）。

### 部分结果与取消

- 每完成一个工作区就上图，不再等整轮结束；流式期间按到达顺序追加槽位（已出现的光点不移动），完成后持久化 assignments。
- 取消不再丢弃已扫结果：保留光点并标「部分结果」+ 计数提示；半截快照不写缓存，刷新回到上次完整扫描。
- 头部新增「部分结果」徽标；正文上方常驻一条说明（缺多少工作区、命中了哪个预算）。

### 超限提示

- 进度条：工作区进度填条，目录预算 80% 转琥珀、100% 转告警；旁列「目录 x / y」「耗时 x / y」，耗时由本地 500ms 时钟补算，单个大工作区不会看起来卡死。
- `limit` 一到就提示原因与数值，并给建议「可在插件配置里调大 maxDirs / timeoutMs」。
- 相关文案中英双语。

### 修复

- **省略预算参数时被静默钳到最小值**：`parseScanQuery` 直接拿 `params.get()` 的结果去钳制，而缺失的参数是 `null`、`Number(null) === 0`，于是每次"没传预算"的请求都被压成 `maxDepth=1 / maxDirs=100 / timeoutMs=250`，实际扫描永远只有一层、100 个目录。改为缺失/空串按配置默认值处理（5 / 20000 / 8000），并补了一条会失败的回归测试。实测同一根目录的目录访问数从 33 变成 5008。
- 扫描完成后不再用一次性 notice 重复「部分结果」——常驻条与头部徽标已经说明同一件事。

### 契约与测试

- `contracts/dto.d.ts` 补 `ScanSummary` / `ScanEvent` / `WorkspaceSource.onEvent`；`contracts/schemas.js` 补 `validateScanSummary` / `validateScanEvent`，`validateSnapshot` 会校验可选的 `scan`；示例快照补 `scan`。
- 测试 148 → 181 条：新增 `host-stream`（事件顺序、`limit` 只发一次、背压、中途断开、协商与错误码）、`scan-progress`（NDJSON 跨块解析、断流/取消/错误行、老 Host 回落、进度归约与部分结果判定）、`progress-view`（进度比例、色阶、中英文案、进度条/部分结果条/空状态的真实元素渲染），另加预算默认值回归测试。

## 0.2.0 — 2026-11-13

### 更名

- 显示名：大脑工作区 → **元婴识海**（英文 Nascent Soul Sea）。只改显示层：包名、row id、slot key、路由、存储键全部保持 `brain-workspaces`，因此无需重装、不会动到已有快照与视角设置。

### 数据

- 扫描上移到 Host 侧：`node:fs` 的 `readdir(withFileTypes)` + 同源只读路由 `/plugins/dsh-brain-workspaces/api/scan`（必须通过 `ctx.connection.requestRejection` 准入与同源校验）。
- 新增 `sessionCount`：只读 `sessionPersistence.list()` 的 `header.cwd`。
- 新增 `lastSessionAt`：同一快照的 `header.createdAt`，取工作区内最大值；没有就不写，不编造时间。
- 符号链接/junction 不再跟随（`dirent.isSymbolicLink()` 直接跳过），顶层与内部都应用忽略名单。

### 视觉

- 神经纤维网加密：云点 230 → 460，连线 500 → ~2100，且每根纤维按确定性控制点弯曲；纤维路径与深度排序在 scene 内预计算，动画时只描边。
- 场景框架：3 圈轨道环 + 底座双环 + 垂直光束（纯装饰，跟随相机投影，随视角一起转）。
- 信号脉冲：7 天窗口内按活跃度排名前 30% 的工作区，会沿最近两条云边流出光点；左下 `◍` 开关，默认开（遵守 `prefers-reduced-motion`），与自动旋转共用唯一 rAF。
- 活跃度 = `max(目录 mtime, 最近新建会话)`，Host 每个工作区一次 `stat`（独立预算，失败不影响状态与计数），填入 DTO 早已预留的 `modifiedAt`。
- 大脑区改为 Canvas 2D + 手写相机（yaw/pitch 旋转 + 透视除法），点云铺在椭球壳上，近大远小 + 深度雾化。
- 颜色编码目录数（9 级色带，对数刻度），大小编码会话数，线型编码扫描状态。
- 4 套主题（nebula / aurora / magma / mono）+ 自定义强调色；视角、缩放、主题、自动旋转都持久化。
- 缩放 LOD：`zoom ≥ 1.55` 或工作区 ≤ 14 个时显示名称；选中/悬停/聚焦永远显示。
- 点击珠子时镜头平滑聚焦（420ms，easeOutCubic），拖拽会取消聚焦并停掉自动旋转。

### 修复

- 指纹捕获（`setPointerCapture`）导致 click 被重定向，选中失效 —— 拖拽改为 window 级监听，按在珠子上永不启动拖拽。
- 扫描失败不再显示成「没有子目录」，改为红色失败态。
- 客户端不再覆盖扫描预算，`cordis.patch.yml` 的 `maxDepth` 等配置真正生效。

### 测试

116 条（`node --test tests/`）：路径守卫与两份实现一致性、布局确定性/越界/500 节点不重叠、Host 扫描计数与预算、路由准入与错误码、HTTP 扫描器失败语义、投影与壳层、主题与色带、LOD、点击/拖拽判定、存储降级。

## 0.1.0 — 2026-11-13

- 首个可用版本：SVG 大脑轮廓 + 稳定槽位布局 + 本地只读扫描 + 搜索/选中/详情。
