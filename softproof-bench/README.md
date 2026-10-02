# 软打样台 · Soft-Proof Bench

一个**纯浏览器** ICC 软打样工作台。先让印前人员明确图片来自哪个色彩空间，再查看转换到印厂配置后的颜色变化。所有像素处理与 ICC 转换都在本机用 WebAssembly 完成，**图片与配置不上传任何服务器**。

- **色彩引擎**：[LittleCMS 2](https://github.com/mm2/Little-CMS) 的 WebAssembly 构建 [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm)
- **界面**：Svelte 5 + TypeScript + Vite
- **预览**：双 Canvas 并排（原图 / 软打样模拟），点击/悬停取样
- **解码**：`@jsquash` WASM 解码 PNG(8/16-bit)/JPEG/WebP，取原始像素，不经过浏览器色彩管理
- **导出**：自写 PNG（RGB/Gray，8/16-bit，嵌入 iCCP）与 CMYK TIFF 编码器
- **存储**：IndexedDB 保存工程与 ICC 配置库

## 工作流程（与印前纪律对应）

1. **导入图片**（PNG/JPEG/WebP）。读取嵌入 ICC：
   - 有嵌入配置 → 显示其描述、版本、色彩空间（如 `RGB v2.2`），转换以它为准；
   - **缺少配置 → 必须手工选择一个源配置**，选择会作为“假设（assumption）”写入设置记录，不做任何静默猜测。
2. **选择目标印厂配置、渲染意图（4 种）、黑点补偿**，以及软打样模拟意图。
3. **并排预览**：左侧为原始像素；右侧为 `源配置 →（目标设备 proofing）→ sRGB 显示` 的软打样结果。
4. **取样**：在任一画布悬停或单击钉选，查看源/目标设备值（RGB %、CMYK 0–100、灰阶）、两边的 CIE Lab（LittleCMS double 精度）与 ΔE2000、Alpha。
5. **导出**：
   - 转换图像：目标为 RGB/Gray → 嵌入目标 ICC 的 PNG；目标为 CMYK → 嵌入目标 ICC 的 8-bit CMYK TIFF；
   - 设置记录：单独的 JSON，标明源/目标配置、源假设、意图码、BPC、像素哈希与免责声明；
   - 图像文件都带 `softproof-bench-conversion` 标记（PNG tEXt / TIFF ImageDescription）。
6. **防止二次转换**：再次导入带标记的“已转换”文件会被识别并拦截，不能把转换结果当原图再转一次。

## 本机批次打样作业（Batch）

顶部“批次打样作业”标签页把同一版式的多张原稿作为**一个可恢复的本机批次**处理，无需逐张重复配置，也不上传任何文件。

- **条目冻结**：每张图在加入时冻结原图字节、容器/位深、像素哈希（FNV-1a64）、嵌入 ICC 快照，以及实际生效的源/目标配置、渲染意图、黑点补偿（`StoredBatchItem`）。
- **待确认闸门**：无嵌入 ICC 的图片停在“待确认”，**必须人工选择源配置（assumption）**才能入队；入队前缺失任何一项都会被拒绝。
- **状态机**：`待确认 → 排队 → 转换中 → 成功 / 失败 / 已取消`，全程持久化到 IndexedDB（`batch-jobs` / `batch-items` / `batch-outputs`）。
- **尝试历史与并发安全**：每次转换是一个 attempt；重试追加新 attempt，旧失败/取消记录不抹除。结果回传时同时校验 **状态仍为转换中 + attempt id + settingsRevision + 无既有成功输出**，迟到结果、改配置后的旧结果、取消后的迟到像素一律丢弃。
- **刷新恢复**：刷新时把“转换中”条目复位为排队（中断的 attempt 记为 canceled），只续跑非终态条目；成功输出已在 `batch-outputs` 中，绝不重复生成。
- **不合并同像素条目**：条目按自身 id 独立存储；同一像素文件以不同人工假设入队是两个条目、两份输出。
- **批次清单导出**：每张成功图导出嵌入目标 ICC 且带转换标记的 PNG/TIFF，另导出一份 `*.batch-manifest.json`，把每个输出文件与其**各自独立**的源/目标配置、假设、意图码、BPC、attempt id 及失败历史逐一关联。
- 已带转换标记的文件不能加入批次（同单张流程的防二次转换纪律）。

> ⚠️ 未经校准/特征化的显示器上，软打样**不承诺**等同实物打样或印刷成品颜色；本工具用于流程核对、配置确认与数值预览。

## 目录

```
src/lib/
  icc/      ICC 头/标签解析、JPEG APP2 / PNG iCCP / WebP ICCP 提取、出处标记检测
  color/    LittleCMS WASM 封装、转换引擎、CIEDE2000、设置记录、意图常量
  batch/    本机批次作业：类型、状态机/竞态防护、IndexedDB 管理器、批次清单、导出
  codec/    WASM 解码，PNG / CMYK-TIFF 编码（可嵌 ICC）
  db/       IndexedDB、内置开放配置、应用状态（runes）
  workers/  后台转换线程与主线程 client（token 匹配、协作取消、DEV 故障/延迟注入）
  components/  Svelte UI
scripts/      Node 单测、夹具生成、Playwright E2E（单张 + 批次）
public/profiles/  内置开放 ICC（Elle Stone，公有领域/CC0）
test-assets/       色块图、透明边缘图、开放 CMYK 配置（CC0）
```

### 两条转换链不混用

- **转换链** `源 → 目标配置设备编码`：这是导出数据，嵌入目标 ICC。
- **软打样链** `源 → sRGB 显示（cmsCreateProofingTransform，目标为 proof 设备）`：只用于屏幕预览，**绝不**回灌为转换输入。

### 关键实现注记

- `lcms-wasm` 的 JS 封装对 `TYPE_*_DBL` 浮点格式有 bug（按 Float32 暂存而 LittleCMS 需要 Float64）。8/16-bit 路径正常；采样所需的 Lab/XYZ/单像素 double 转换直接操作 Emscripten 堆内存（`_malloc` + `Float64Array` + `_cmsDoTransform`）绕过该问题。
- 像素全程保持打包的“颜色通道 + alpha”（RGBA/CMYKA/GRAYA），用 `cmsFLAGS_COPY_ALPHA` 透传 alpha；导出 CMYK（无 alpha 通道的 TIFF）时对完全透明像素清零油墨。

## 使用

```bash
npm install
npm run dev          # 打开本地页面
```

印厂配置（FOGRA/ISOcoated、GRACoL、Japan Color 等）通过界面的“ICC 配置库”导入 `.icc/.icm`，存于本机 IndexedDB，不随网络下载。内置仅含两个开放的 Elle Stone RGB 配置。

## 测试

```bash
npm run check        # svelte-check + tsc
npm run test:node    # ICC 解析/提取、PNG/TIFF 编码、出处标记、ΔE2000
npm run build        # 生产构建

# E2E（先启动 dev，再用 Playwright 安装好的 Chromium）
npm run dev -- --port 5199 --strictPort
E2E_URL=http://localhost:5199 npm run test:e2e
```

E2E 覆盖：嵌入/缺失配置（强制假设）、CIE RGB 与 CMYK 目标、JPEG(APP2)、16-bit PNG、透明边缘、取样、PNG/TIFF 导出、带标记文件再导入拦截。

批次 E2E（`npm run test:e2e:batch`）覆盖：两张不同嵌入配置图片各自成功并保留快照；无 ICC 图在人工确认前停在待确认且不进队列；同像素不同人工假设不合并；转换中刷新后只续跑未终态条目、已完成输出不重复生成；失败后重试生成新尝试记录而保留原失败与其他条目成功；已转换文件禁止作为批次原图。

### 用独立色彩工具验证导出文件

导出文件已用带 lcms 委托的 **ImageMagick 6** 独立验证可被读取：

```bash
identify -verbose export.png | grep -i icc:description     # 目标配置名
identify -verbose export.tif | grep -iE 'Colorspace|icc'   # CMYK + 嵌入 ICC
convert export.tif -colorspace sRGB render.png             # 用嵌入 ICC 独立再渲染
```

数值上，浏览器内 WASM 与 ImageMagick 独立 LCMS 对同一色块（sRGB 纯红 → ISO Coated v2，相对色度+BPC）给出一致的 CMYK `(0,244,254,0)`。

## 开放配置来源

- Elle Stone `elles_icc_profiles`（sRGB、CIE RGB；公有领域/CC0 贡献），随应用内置。
- ISO Coated v2 300%（Amethyst，pmjdebruijn/amethyst-cmyk-icc-profiles，CC0）仅随测试夹具提供，不在应用内分发；正式生产请向印厂索取配置。

## 许可

应用代码 MIT。LittleCMS MIT。解码 WASM（Squoosh 系）Apache-2.0。
