/**
 * UI copy (zh / en), picked by the document language at call time. The pet
 * lives on a global floating surface and a settings page, and resolves its
 * copy the same small way on both.
 * @module dsh-dpet/client/i18n
 */

const zh = {
  'settings.title': '桌宠',
  'settings.subtitle': '把任何形象变成陪你写代码的桌宠：3D 模型、图片、GIF 都能直接用，它会跟着 AI 的状态做动作。',
  'settings.enabled': '显示桌宠',

  'stage.tip': '实时预览 · 点它一下 · 移动鼠标它会看你',
  'stage.previewState': '预览 AI 状态：',
  'stage.loadFailed': '形象加载失败，请检查文件',
  'stage.vendorMissing': '3D 组件缺失，请重新构建插件',

  'phase.idle': '空闲',
  'phase.waiting': '准备',
  'phase.thinking': '思考',
  'phase.tool': '调用工具',
  'phase.review': '回复中',
  'phase.done': '完成',
  'phase.failed': '出错',

  'motion.bob': '呼吸',
  'motion.sway': '张望',
  'motion.spin': '转圈',
  'motion.hop': '蹦跶',
  'motion.nod': '点头',
  'motion.cheer': '欢呼',
  'motion.droop': '低落',
  'motion.still': '静止',

  'info.type': '类型',
  'info.kind3d': '3D 模型',
  'info.kind2d': '2D 图片',
  'info.kindGif': 'GIF 动图',
  'info.detail': '详情',
  'info.author': '作者',
  'info.source': '来源',
  'info.builtin': '内置形象',
  'info.imported': '你导入的形象',
  'info.triangles': '{n} 面',
  'info.use': '设为桌宠',
  'info.using': '使用中',
  'info.rename': '改名',
  'info.renameSave': '保存',
  'info.renameCancel': '取消',
  'info.delete': '删除',
  'info.confirmDelete': '确定删除「{name}」吗？删除后无法恢复。',
  'info.highlight3d': '3D 实时渲染：真正的立体模型，会转、会跳',
  'info.highlightAgent': '跟着 AI 动：思考转圈、跑命令蹦跶、完成欢呼',
  'info.highlight2d': '2D 也会动：一张静态图也能呼吸、蹦跶',

  'gallery.title': '我的桌宠',
  'gallery.hint': '点卡片预览，再点「设为桌宠」启用。把 .glb 模型或图片直接拖到这里，就能变成新桌宠，不用写任何配置。',
  'gallery.add': '导入新形象',
  'gallery.addHint': '拖进来或点这里',
  'gallery.formats': '3D：.glb　2D：.png .jpg .webp .gif',
  'gallery.drop': '松手就能导入',

  'import.uploading': '正在上传 {file}（{size}）',
  'import.processing': '正在自动优化…',
  'import.done': '导入完成：{name} 已经加入你的桌宠',
  'import.failed': '导入失败：{reason}',
  'import.close': '收起',
  'import.review': '确认导入：{file}',
  'import.reviewHint': '点选你想要的版本，确认后再生成桌宠。',
  'import.original': '原图',
  'import.cleaned': '去掉背景后',
  'import.bg.working': '正在去背景…',
  'import.bg.removed': '已去掉 {color} 背景',
  'import.bg.transparent': '图片本身就是透明背景，无需处理',
  'import.bg.not-uniform': '背景不是纯色，暂时无法自动去除（复杂背景的 AI 抠图在下一批支持）',
  'import.name': '名字',
  'import.create': '生成桌宠',
  'import.cancel': '取消',
  'import.step.bgRemoved': '去掉纯色背景（{color}）',
  'import.step.bgKept': '保留原背景',
  'import.step.bgTransparent': '图片本身是透明背景',
  'import.step.bgComplex': '背景不是纯色，保留原样',
  'import.step.format': '识别格式：{format}',
  'import.step.mesh': '减面：{from} → {to} 面',
  'import.step.texture': '贴图压缩到 {size}px（WebP）',
  'import.step.bytes': '体积：{from} → {to}',
  'import.step.trim': '去掉透明边、限制尺寸',
  'import.step.gif': 'GIF 保留原动画',
  'import.step.ready': '已生成桌宠，自动套用动作',
  'import.step.preview': '已生成封面',
  'error.unsupported-format': '不支持这种文件，3D 请用 .glb，2D 请用 png / jpg / webp / gif',
  'error.file-too-large': '文件太大了',
  'error.body-too-large': '文件太大了',
  'error.invalid-glb': '模型文件无法读取',
  'error.compressed-glb-unsupported': '暂不支持 Draco / meshopt 压缩过的模型',
  'error.invalid-image': '图片无法读取',
  'error.network': '网络错误，请重试',

  'mapping.title': '动作编排',
  'mapping.reset': '恢复默认',

  'place.title': '位置与外观',
  'place.hint': '拖动小窗里的桌宠摆放位置；也可以直接在页面上拖动桌宠本身。',
  'place.window': 'DSH 窗口',
  'place.position': '位置：距右 {right}px，距下 {bottom}px',
  'place.size': '大小',
  'place.opacity': '透明度',
  'place.look': '看向鼠标',
  'place.lookHint': '鼠标移动时，桌宠会转头看你',
  'place.bubbles': '状态气泡',
  'place.bubblesHint': '显示「思考中…」这类提示',

  'roadmap.title': '图生 3D：一张照片直接变 3D 桌宠',
  'roadmap.tag': '即将推出',
  'roadmap.hint': '上传一张图片，自动完成生成、优化、导入：',
  'roadmap.step1': '选一张图片',
  'roadmap.step1Hint': '吉祥物、宠物照片都行',
  'roadmap.step2': '腾讯混元生成 3D',
  'roadmap.step2Hint': '使用你自己的腾讯云密钥',
  'roadmap.step3': '自动压缩优化',
  'roadmap.step3Hint': '几十 MB 压到 2 MB 左右',
  'roadmap.step4': '变成桌宠',
  'roadmap.step4Hint': '自动套用动作',

  'line.prepare': '{name}准备开工～',
  'line.waiting': '{name}在等 AI 回话…',
  'line.blocked': '{name}在等你确认',
  'line.thinking': '{name}思考中…',
  'line.writing': '{name}在写回复…',
  'line.tool': '{name}在{tool}…',
  'line.toolRetry': '工具出了点小问题，{name}再想想',
  'line.done': '搞定！',
  'line.failed': '呜…出错了',
  'line.interrupted': '好的，先停下',
  'tool.shell': '跑命令',
  'tool.read': '读文件',
  'tool.edit': '改代码',
  'tool.search': '找东西',
  'tool.web': '上网查资料',
  'tool.other': '用工具',
  'menu.sectionAi': '交给 AI（填入输入框，不会自动发送）',
  'menu.sectionQuick': '快捷操作',
  'menu.aiSwitch': '让 AI 帮我换个形象',
  'menu.aiImport': '用图片或模型做桌宠',
  'menu.aiMotions': '让 AI 调整动作',
  'menu.aiIntro': '问问 AI 桌宠能做什么',
  'menu.bigger': '变大一点',
  'menu.smaller': '变小一点',
  'menu.home': '回到右下角',
  'prompt.switch': '用 DPet 的工具看看我的桌宠库里有哪些形象，帮我挑一个换上，并说说理由。',
  'prompt.import': '用 DPet 的工具把这个文件做成我的桌宠：（在这里粘贴图片或 .glb 模型的完整路径）',
  'prompt.motions': '用 DPet 的工具调整桌宠的动作：思考时（ ），完成时（ ）。可选动作：呼吸、张望、转圈、蹦跶、点头、欢呼、低落、静止。',
  'prompt.intro': '介绍一下 DPet 桌宠插件能做什么，以及我可以怎样用一句话让你帮我设置它。',
  'notice.injected': '已填入输入框，确认后再发送',
  'notice.skipped': '输入框里有你没发的内容，没有覆盖',
  'notice.clipboard': '已复制到剪贴板，粘贴到输入框即可',
  'notice.failed': '没能填入输入框',
  'place.reducedMotion': '系统开启了「减少动画」，桌宠会保持静止。',
  'tap.1': '嘿嘿，被你戳到啦～',
  'tap.2': '别戳啦，在认真干活呢',
  'tap.3': '摸摸头，今天也要加油！',
  'tap.4': '{name}在这儿～',
}

type Key = keyof typeof zh

const en: Record<Key, string> = {
  'settings.title': 'Desktop Pet',
  'settings.subtitle': 'Turn any character into a coding companion: 3D models, pictures and GIFs all work, and it moves with what the AI is doing.',
  'settings.enabled': 'Show pet',

  'stage.tip': 'Live preview · click it · move the mouse and it looks at you',
  'stage.previewState': 'Preview AI state:',
  'stage.loadFailed': 'Could not load this character; check the file',
  'stage.vendorMissing': 'The 3D component is missing; rebuild the plugin',

  'phase.idle': 'Idle',
  'phase.waiting': 'Preparing',
  'phase.thinking': 'Thinking',
  'phase.tool': 'Using tools',
  'phase.review': 'Replying',
  'phase.done': 'Done',
  'phase.failed': 'Error',

  'motion.bob': 'Breathe',
  'motion.sway': 'Look around',
  'motion.spin': 'Spin',
  'motion.hop': 'Hop',
  'motion.nod': 'Nod',
  'motion.cheer': 'Cheer',
  'motion.droop': 'Droop',
  'motion.still': 'Still',

  'info.type': 'Type',
  'info.kind3d': '3D model',
  'info.kind2d': '2D image',
  'info.kindGif': 'GIF',
  'info.detail': 'Details',
  'info.author': 'Author',
  'info.source': 'Source',
  'info.builtin': 'Built-in',
  'info.imported': 'Imported by you',
  'info.triangles': '{n} triangles',
  'info.use': 'Use this pet',
  'info.using': 'In use',
  'info.rename': 'Rename',
  'info.renameSave': 'Save',
  'info.renameCancel': 'Cancel',
  'info.delete': 'Delete',
  'info.confirmDelete': 'Delete "{name}"? This cannot be undone.',
  'info.highlight3d': 'Real-time 3D: a real model that spins and jumps',
  'info.highlightAgent': 'Follows the AI: spins while thinking, hops while running tools',
  'info.highlight2d': '2D moves too: a still picture breathes and hops',

  'gallery.title': 'My pets',
  'gallery.hint': 'Click a card to preview, then "Use this pet". Drop a .glb model or a picture here to make a new pet — no config needed.',
  'gallery.add': 'Import',
  'gallery.addHint': 'Drop here or click',
  'gallery.formats': '3D: .glb   2D: .png .jpg .webp .gif',
  'gallery.drop': 'Release to import',

  'import.uploading': 'Uploading {file} ({size})',
  'import.processing': 'Optimizing…',
  'import.done': 'Imported: {name} joined your pets',
  'import.failed': 'Import failed: {reason}',
  'import.close': 'Close',
  'import.review': 'Confirm import: {file}',
  'import.reviewHint': 'Pick the version you want, then create the pet.',
  'import.original': 'Original',
  'import.cleaned': 'Background removed',
  'import.bg.working': 'Removing background…',
  'import.bg.removed': 'Removed the {color} background',
  'import.bg.transparent': 'Already transparent, nothing to remove',
  'import.bg.not-uniform': 'The background is not a plain color and cannot be removed automatically yet (AI cut-out comes next)',
  'import.name': 'Name',
  'import.create': 'Create pet',
  'import.cancel': 'Cancel',
  'import.step.bgRemoved': 'Removed plain background ({color})',
  'import.step.bgKept': 'Kept the original background',
  'import.step.bgTransparent': 'Already transparent',
  'import.step.bgComplex': 'Background is not plain, kept as is',
  'import.step.format': 'Format: {format}',
  'import.step.mesh': 'Triangles: {from} → {to}',
  'import.step.texture': 'Textures resized to {size}px (WebP)',
  'import.step.bytes': 'Size: {from} → {to}',
  'import.step.trim': 'Trimmed transparent borders, bounded size',
  'import.step.gif': 'GIF animation kept as is',
  'import.step.ready': 'Pet created with default motions',
  'import.step.preview': 'Thumbnail created',
  'error.unsupported-format': 'Unsupported file: use .glb for 3D, png / jpg / webp / gif for 2D',
  'error.file-too-large': 'The file is too large',
  'error.body-too-large': 'The file is too large',
  'error.invalid-glb': 'The model file could not be read',
  'error.compressed-glb-unsupported': 'Draco / meshopt compressed models are not supported yet',
  'error.invalid-image': 'The image could not be read',
  'error.network': 'Network error, please retry',

  'mapping.title': 'Motions',
  'mapping.reset': 'Reset',

  'place.title': 'Position & look',
  'place.hint': 'Drag the pet in the mini window, or drag the pet itself on the page.',
  'place.window': 'DSH window',
  'place.position': 'Position: {right}px from right, {bottom}px from bottom',
  'place.size': 'Size',
  'place.opacity': 'Opacity',
  'place.look': 'Look at cursor',
  'place.lookHint': 'The pet turns toward your mouse',
  'place.bubbles': 'Status bubble',
  'place.bubblesHint': 'Shows hints like "Thinking…"',

  'roadmap.title': 'Image to 3D: turn one photo into a 3D pet',
  'roadmap.tag': 'Coming soon',
  'roadmap.hint': 'Upload a picture and the rest happens automatically:',
  'roadmap.step1': 'Pick a picture',
  'roadmap.step1Hint': 'A mascot or a pet photo',
  'roadmap.step2': 'Tencent Hunyuan 3D',
  'roadmap.step2Hint': 'With your own Tencent Cloud key',
  'roadmap.step3': 'Auto-optimize',
  'roadmap.step3Hint': 'Tens of MB down to about 2 MB',
  'roadmap.step4': 'It becomes a pet',
  'roadmap.step4Hint': 'Motions applied',

  'line.prepare': '{name} is getting ready',
  'line.waiting': '{name} is waiting for the AI…',
  'line.blocked': '{name} is waiting for your approval',
  'line.thinking': '{name} is thinking…',
  'line.writing': '{name} is writing…',
  'line.tool': '{name} is {tool}…',
  'line.toolRetry': 'A tool hiccuped; {name} is rethinking',
  'line.done': 'Done!',
  'line.failed': 'Oops, something failed',
  'line.interrupted': 'OK, stopping',
  'tool.shell': 'running a command',
  'tool.read': 'reading files',
  'tool.edit': 'editing code',
  'tool.search': 'searching',
  'tool.web': 'browsing the web',
  'tool.other': 'using a tool',
  'menu.sectionAi': 'Ask the AI (fills the input, never sends)',
  'menu.sectionQuick': 'Quick actions',
  'menu.aiSwitch': 'Let the AI pick a new look',
  'menu.aiImport': 'Make a pet from a picture or model',
  'menu.aiMotions': 'Let the AI adjust the motions',
  'menu.aiIntro': 'Ask what the pet can do',
  'menu.bigger': 'Bigger',
  'menu.smaller': 'Smaller',
  'menu.home': 'Back to the bottom right',
  'prompt.switch': 'Use the DPet tools to look at the pets in my library, pick one for me, switch to it, and tell me why.',
  'prompt.import': 'Use the DPet tools to turn this file into my desktop pet: (paste the full path of the picture or .glb model here)',
  'prompt.motions': 'Use the DPet tools to change the pet motions: while thinking ( ), when done ( ). Motions: breathe, look around, spin, hop, nod, cheer, droop, still.',
  'prompt.intro': 'Tell me what the DPet desktop pet plugin can do, and how I can set it up with a single sentence to you.',
  'notice.injected': 'Put in the input box; send it when ready',
  'notice.skipped': 'Your unsent text is in the input box; left it alone',
  'notice.clipboard': 'Copied to the clipboard; paste it into the input box',
  'notice.failed': 'Could not fill the input box',
  'place.reducedMotion': 'Reduced motion is on in your system; the pet stays still.',
  'tap.1': 'Hehe, you poked me!',
  'tap.2': 'Hey, I am working here',
  'tap.3': 'Head pat received. Keep going!',
  'tap.4': '{name} is here',
}

export type I18nKey = Key

/** The dictionary for the current document language. */
function dictionary(): Record<Key, string> {
  const lang = typeof document === 'undefined' ? 'zh' : document.documentElement.lang
  return lang.toLowerCase().startsWith('en') ? en : zh
}

/** Translate a key with optional `{name}` params. */
export function t(key: Key, params?: Record<string, string | number>): string {
  let text = dictionary()[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll('{' + name + '}', String(value))
  }
  return text
}

/** Friendly verb for a tool name. */
export function toolLabel(tool: string | undefined): string {
  const name = (tool ?? '').toLowerCase()
  if (/bash|shell|exec|command|terminal|run/.test(name)) return t('tool.shell')
  if (/grep|glob|search|find|list|ls/.test(name)) return t('tool.search')
  if (/write|edit|patch|replace|create/.test(name)) return t('tool.edit')
  if (/read|view|cat|open/.test(name)) return t('tool.read')
  if (/web|fetch|http|browse|url/.test(name)) return t('tool.web')
  return t('tool.other')
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

/** Human-readable triangle count (zh uses 万). */
export function formatCount(n: number): string {
  if (dictionary() === zh && n >= 10_000) return (n / 10_000).toFixed(n >= 100_000 ? 0 : 1) + ' 万'
  return n.toLocaleString()
}
