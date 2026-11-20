(() => {
  const STORAGE_KEY = 'ags-site-lang';
  const REPO_API_LATEST = 'https://api.github.com/repos/xjzc-mt/agent-switcher/releases/latest';
  const RELEASES_URL = 'https://github.com/xjzc-mt/agent-switcher/releases';

  const STAGE_VIEWS = {
    cards: {
      file: '01-codex-cards.png',
      captionKey: 'stage.capCards',
      altKey: 'stage.altCards',
    },
    rows: {
      file: '02-codex-rows.png',
      captionKey: 'stage.capRows',
      altKey: 'stage.altRows',
    },
    agy: {
      file: '03-antigravity.png',
      captionKey: 'stage.capAgy',
      altKey: 'stage.altAgy',
    },
    settings: {
      file: '08-settings.png',
      captionKey: 'stage.capSettings',
      altKey: 'stage.altSettings',
    },
  };

  const I18N = {
    zh: {
      'meta.title': 'AgentSwitcher · AGS — AI 编程 Agent 多账号与额度管理工具',
      'meta.desc':
        '把多个个人号、团队号或朋友临时借用的 Codex、Antigravity 账号放进同一个 macOS 桌面窗口：谁还有余量一眼看清，点一下顺手切换，零自建后端，本地 AES-256-GCM 加密。',
      'nav.features': '核心场景',
      'nav.security': '安全与支持',
      'nav.install': '快速安装',
      'nav.gate': '门后彩蛋',
      'common.zoom': '查看大图',
      'common.copy': '复制',
      'common.copied': '已复制',
      'hero.motto': '与 Agent 并肩，与伙伴同行，携手走向 AGI 之门。',
      'hero.title': '多个 AI Agent 账号，一眼看清余量，点一下顺手切换',
      'hero.lead':
        '不管你手头攒了多个个人号与团队号，还是搭档、朋友临时借你一个 Codex 或 Antigravity 账号救急——放进同一个 macOS 桌面窗口，谁还有余量一目了然，既不打断心流，也不误覆盖原有主号。',
      'hero.releaseHistory': '查看发布记录',
      'hero.source': '查看 GitHub 源码',
      'hero.installGuide': '首次打开指引',
      'hero.fact1': 'macOS Apple Silicon',
      'hero.fact2': '支持 Codex 与 Antigravity',
      'hero.fact3': '零自建后端 · 本地 AES-256-GCM',
      'hero.fact4': 'MIT 许可证',
      'stage.tabCards': 'Codex 卡片总览',
      'stage.tabRows': 'Codex 单行对比',
      'stage.tabAgy': 'Antigravity 模型组',
      'stage.tabSettings': '偏好与更新',
      'stage.capCards': '当前账号置顶，备用账号按套餐归组并按可用余量排序，右侧点一下即可切换。',
      'stage.capRows': '紧凑单行视图，按套餐密集对齐比较多个账号的 5h / 7d 余量与 Credits。',
      'stage.capAgy': '以 Gemini 为主额度并独立展示 Claude / GPT 模型组，缺失值如实显示「—」。',
      'stage.capSettings': '可调整显示和登录偏好、导出脱敏故障报告，以及检查应用更新。',
      'stage.altCards': 'Codex 账号总览：当前账号、套餐分组和备用额度',
      'stage.altRows': 'Codex 单行视图：按套餐比较多个账号的额度',
      'stage.altAgy': 'Antigravity：当前与备用账号的模型组额度',
      'stage.altSettings': '设置：紧凑的偏好、清理辅助与应用更新',
      'stage.demoNote': '真实桌面界面截图（使用虚构账号与模拟额度，不含真实凭据）',
      'features.title': '顺手完成三件高频小事',
      'features.subtitle': '界面刻意保持紧凑与克制，所有操作围绕识别账号、比较余量与安全切换展开，不堆多余装饰。',
      'f1.title': '看余量，不盲猜',
      'f1.desc':
        '当前账号置顶，备用账号按套餐归组、按可用余量排好序，支持卡片与单行两种视图。Codex 分列 5h / 7d 与 Credits；Antigravity 以 Gemini 为主并独立展示 Claude / GPT 等模型组，缺失值如实显示「—」，不混算总比例。',
      'f1.tab1': 'Codex 单行对比',
      'f1.tab2': 'Antigravity 主次分层',
      'f1.cap1': '密集对齐的单行视图，适合账号较多时快速横比 5h / 7d 与 Credits。',
      'f1.cap2': 'Gemini 主额度与 Claude / GPT 次要模型组分层展示，各自独立计剩余比例。',
      'f2.title': '添账号，不掉线',
      'f2.desc':
        '拉起官方浏览器（支持无痕窗口与连续添加）独立完成授权，不踢掉当前正在工作的客户端。多账号 JSON 可先预览、改名、按身份去重再导入；过期账号支持原位更新并保留昵称，替换文件凭据前先校验归属。',
      'f2.tab1': '独立浏览器授权',
      'f2.tab2': '批量导入预览',
      'f2.cap1': '仅放行 OpenAI 与 Google 官方授权域名，支持无痕登录与连续入池。',
      'f2.cap2': '批量导入前可逐条筛选、改名、按身份去重并原位更新过期凭据。',
      'f3.title': '留备份，不伤现场',
      'f3.desc':
        '勾选账号并设置独立密码即可导出 .ags 加密备份，方便跨机迁移。移除账号前先核对同身份范围，默认只删除 AGS 内的备份，完整保留官方客户端登录、聊天历史与项目文件。',
      'f3.tab1': '.ags 加密备份',
      'f3.tab2': '移除范围确认',
      'f3.cap1': '用独立密码派生密钥加密导出，避免明文凭据散落在本地或传输途中。',
      'f3.cap2': '移除前先摊开核对同身份备份数量，退出客户端登录默认不勾选，由你主动决定。',
      'security.title': '安全边界与支持范围',
      'security.subtitle': '涉及账号凭据的工具先讲清楚边界：零自建服务器、源码公开可审，只动登录凭据，不碰聊天记录与项目配置。',
      'security.pillarsTitle': '本地安全保障',
      'security.p1Title': '零自建后端，透明可审',
      'security.p1Desc':
        '登录仅放行 OpenAI 与 Google 官方授权域名。故障记录保存在本机，可在设置中导出脱敏报告并自行转交维护者。',
      'security.p2Title': '本机强加密与钥匙串托管',
      'security.p2Desc':
        '池内凭据经 `AES-256-GCM` 加密（文件权限 `0600`），主密钥由 macOS Keychain 托管；`.ags` 备份由你设置的独立密码派生密钥。',
      'security.p3Title': '不丢号、不越界',
      'security.p3Desc':
        '未入池的当前登录在切换前会弹窗提醒保护；只替换登录凭据，不动聊天历史与项目配置，也不会在后台偷偷自动切号。',
      'security.p4Title': '使用边界明确',
      'security.p4Desc':
        '放入他人账号须事先获持有人授权；本版仅限本机使用，不含联网中转或多人共享服务。',
      'support.title': '平台支持现状',
      'support.colPlatform': '平台',
      'support.colStatus': '状态',
      'support.colDetail': '支持范围与条件',
      'support.ready': '已支持',
      'support.planned': '规划中',
      'support.codexDesc':
        '独立登录、auth.json 切换、5h / 7d 额度与 Credits（需本机 Codex 客户端；Keychain-only 未适配，API Key 无订阅额度）。',
      'support.agyDesc':
        'macOS 2.x 个人 Google 账号独立登录、Keychain 或官方文件切换与模型组额度（需官方 agy CLI；企业认证暂未验证）。',
      'support.claudeDesc': '保留底层兼容代码，首版 GUI 入口暂置灰，待补齐激活与额度能力后开放。',
      'support.foot': '1.0.1 候选源码面向 macOS Apple Silicon，包含桌面版和 ags 命令行工具。Windows Codex 兼容性仍待实机验收。',
      'install.title': '下载与快速安装',
      'install.subtitle': '拥有候选源码的用户可通过 Node.js 22.12+ 直接运行。已公开的正式安装包可在 GitHub Releases 查看。',
      'install.dmgTitle': '桌面版安装包（DMG）',
      'install.dmgMeta': '尚未确认可下载的 Apple Silicon 正式安装包。',
      'install.dmgDirectMeta': 'macOS Apple Silicon · 直连 GitHub Release 安装包',
      'install.downloadDirect': '直接下载 Apple Silicon DMG',
      'install.allReleases': '所有版本与说明',
      'install.gatekeeperTitle': '首次打开提示「无法验证开发者」？',
      'install.gatekeeperDesc':
        '首发包采用 ad-hoc 签名（尚未接入 Apple 公证）。核对下载来源后，打开「系统设置 → 隐私与安全性」，滑到底部点击「仍要打开」即可放行。',
      'install.verifyLabel': '可选：校验 DMG 完整性',
      'install.cliTitle': '源码运行与 ags CLI',
      'install.cliDesc': '适合想直接审计源码、打包最新工作区，或在终端用 ags 命令快速切换的开发者（需 Node.js 22.12+）。',
      'install.sourceLabel': '克隆并启动桌面窗口',
      'install.cliLabel': '常用 ags 命令（构建后 npm link 安装）',
      'gate.title': '门后的彩蛋',
      'gate.lead': '顶部那扇「AGI 之门」下，人与众 Agent 并肩、人与人彼此托举——AgentSwitcher v1.0 只是序章。',
      'gate.teaser': '一款围绕「私密信任圈 · 额度零浪费 · 彼此互助」打造的个人微中转产品已进入发布倒计时，即将揭晓。',
      'gate.summary': '推开高门 · 解锁「终局形态」预言',
      'gate.story':
        '今天朋友借号还得导凭据，深夜里大量订阅窗口又在倒计时中白白清零。而在终局形态里，每个人都可以是一座自主受控的「个人小中转」（并非公共商业号池或账号倒卖，而是熟人与小团队的私密互助工具）：',
      'gate.b1': '**借力免交凭据**：账号空闲时，本机即可化作轻量微中转节点，搭档按需借力，无需交出密码或明文 JSON。',
      'gate.b2':
        '**信任圈私密默认，开关全权在己**：默认仅对认可的熟人与小团队开放；谁能连、用多少、外部限制开关均由你本机实时掌控、随时撤回。',
      'gate.b3': '**闲置余量零浪费**：队友赶工借你空闲窗口顶上，你冲刺时也有伙伴余量接力，让每一份订阅物尽其用。',
      'gate.cta': '去 GitHub 点 Star 并订阅 Releases',
      'gate.footnote': '彩蛋介绍下一代独立产品。AgentSwitcher 在本机管理账号与额度。',
      'footer.license': 'MIT 开源协议',
      'footer.docs': '账号管理文档',
    },
    en: {
      'meta.title': 'AgentSwitcher · AGS — Multi-Account & Quota Manager for AI Coding Agents',
      'meta.desc':
        'Manage personal, team, and borrowed Codex & Antigravity accounts in one macOS desktop window. Compare remaining quotas at a glance and switch safely — local-first, AES-256-GCM encrypted, zero backend.',
      'nav.features': 'Workflows',
      'nav.security': 'Security & Support',
      'nav.install': 'Install',
      'nav.gate': 'Beyond the Gate',
      'common.zoom': 'Zoom image',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'hero.motto': 'Side by side with your agents, walking together toward the AGI gate.',
      'hero.title': 'See remaining quota across AI agent accounts, switch in one click',
      'hero.lead':
        'Whether you juggle personal and team accounts or borrow a teammate’s Codex or Antigravity account in a crunch — keep them in one calm macOS desktop window, see who still has quota left, and switch without breaking flow or overwriting an unsaved primary login.',
      'hero.releaseHistory': 'View releases',
      'hero.source': 'View Source on GitHub',
      'hero.installGuide': 'First-launch guide',
      'hero.fact1': 'macOS Apple Silicon',
      'hero.fact2': 'Codex & Antigravity supported',
      'hero.fact3': 'Zero backend · Local AES-256-GCM',
      'hero.fact4': 'MIT license',
      'stage.tabCards': 'Codex Cards',
      'stage.tabRows': 'Codex Row View',
      'stage.tabAgy': 'Antigravity Groups',
      'stage.tabSettings': 'Settings & Updates',
      'stage.capCards':
        'Active account pinned at the top, backups grouped by plan and sorted by usable quota — one click to switch.',
      'stage.capRows':
        'Compact single-row comparison aligned across plans for fast scanning of 5h / 7d windows and Credits.',
      'stage.capAgy':
        'Gemini shown as primary quota alongside independent Claude / GPT model groups; missing values stay "—".',
      'stage.capSettings':
        'Change display and sign-in preferences, export a redacted diagnostic report, or check for app updates.',
      'stage.altCards': 'Codex overview: active account, plan groups, and backup quotas',
      'stage.altRows': 'Codex compact row view comparing quotas across accounts',
      'stage.altAgy': 'Antigravity active and backup accounts with model group quotas',
      'stage.altSettings': 'Settings: compact preferences, cleanup helper, and app updates',
      'stage.demoNote': 'Real desktop captures using mock accounts and simulated quotas (no real credentials)',
      'features.title': 'Built for three everyday moments',
      'features.subtitle':
        'Deliberately compact and restrained — every view focuses on identifying accounts, comparing real quota buckets, and switching safely.',
      'f1.title': 'Check quota without guessing',
      'f1.desc':
        'Your active account stays pinned on top while backups are grouped by plan and sorted by remaining availability in Card or Row view. Codex separates 5h / 7d windows and Credits; Antigravity leads with Gemini and keeps Claude / GPT model groups independent without blending percentages.',
      'f1.tab1': 'Codex Row View',
      'f1.tab2': 'Antigravity Hierarchy',
      'f1.cap1': 'Tightly aligned single-row table built for comparing many accounts across 5h / 7d windows and Credits.',
      'f1.cap2': 'Gemini primary quota paired with separate Claude / GPT summaries — never merged into a fake total.',
      'f2.title': 'Add accounts without signing out',
      'f2.desc':
        'Launch the official browser flow (with incognito and continuous-add options) to authorize new accounts without kicking out your running desktop client. Preview, rename, and deduplicate multi-account JSON before importing, or refresh expired accounts in place while verifying ownership.',
      'f2.tab1': 'Isolated Browser Login',
      'f2.tab2': 'Batch Import Preview',
      'f2.cap1': 'Allows only official OpenAI and Google auth domains, with incognito and continuous adding.',
      'f2.cap2': 'Review every entry before import: select, rename, deduplicate by identity, and update expired tokens in place.',
      'f3.title': 'Back up and remove without collateral damage',
      'f3.desc':
        'Select accounts and set a dedicated password to export an encrypted .ags archive for moving between Macs. Before removing any account, inspect the exact scope — by default only AGS backups are removed while your official client login, chat history, and project files stay intact.',
      'f3.tab1': 'Encrypted .ags Backup',
      'f3.tab2': 'Safe Removal Scope',
      'f3.cap1': 'Password-derived encryption protects exported .ags backups during local archival or migration.',
      'f3.cap2': 'Inspect every matching backup before deletion; signing out of the official client is opt-in and off by default.',
      'security.title': 'Security boundaries & platform support',
      'security.subtitle':
        'Credential tools should be boring and auditable: no custom servers, open source, and strict separation between login tokens and your workspaces.',
      'security.pillarsTitle': 'Local-first security guarantees',
      'security.p1Title': 'Zero custom backend, open to audit',
      'security.p1Desc':
        'Sign-in is limited to official OpenAI and Google authorization domains. Diagnostic records stay on your Mac. You can export a redacted report from Settings and share it with a maintainer.',
      'security.p2Title': 'Strong local encryption & macOS Keychain',
      'security.p2Desc':
        'Stored credentials are encrypted with `AES-256-GCM` (`0600` file mode) using a master key held in macOS Keychain; `.ags` exports use keys derived from your own backup password.',
      'security.p3Title': 'No silent overwrites or side effects',
      'security.p3Desc':
        'Unsaved active logins trigger a protection prompt before switching. AGS swaps login credentials only — never touching chat history, project settings, or auto-switching in the background.',
      'security.p4Title': 'Clear local-only scope',
      'security.p4Desc':
        'Only store accounts you own or have explicit permission to use. This release is strictly local to your Mac with no online relay or account sharing.',
      'support.title': 'Supported platforms',
      'support.colPlatform': 'Platform',
      'support.colStatus': 'Status',
      'support.colDetail': 'Capabilities & requirements',
      'support.ready': 'Supported',
      'support.planned': 'Planned',
      'support.codexDesc':
        'Isolated sign-in, auth.json switching, 5h / 7d quota windows & Credits (requires local Codex app; Keychain-only not yet adapted; API keys have no subscription quota).',
      'support.agyDesc':
        'macOS 2.x personal Google account isolated sign-in, Keychain or official file switching & model-group quotas (requires official agy CLI; enterprise auth unverified).',
      'support.claudeDesc':
        'Core compatibility code kept in place; GUI entry disabled in v1.0 until activation and quota tracking are completed.',
      'support.foot': 'The 1.0.1 source candidate targets macOS on Apple Silicon and includes the desktop app and ags CLI. Windows compatibility for Codex is still under test.',
      'install.title': 'Download & quick install',
      'install.subtitle':
        'Run a checkout of the candidate with Node.js 22.12+ or look for a published installer on GitHub Releases.',
      'install.dmgTitle': 'Desktop Installer (DMG)',
      'install.dmgMeta': 'An Apple Silicon installer from a stable release could not be confirmed.',
      'install.dmgDirectMeta': 'macOS Apple Silicon · Direct GitHub Release DMG',
      'install.downloadDirect': 'Download Apple Silicon DMG',
      'install.allReleases': 'All releases & notes',
      'install.gatekeeperTitle': 'macOS says the developer cannot be verified?',
      'install.gatekeeperDesc':
        'Initial builds use ad-hoc signing (not yet Apple notarized). After verifying the release source, open System Settings → Privacy & Security, scroll to the bottom, and click "Open Anyway".',
      'install.verifyLabel': 'Optional: verify DMG checksum',
      'install.cliTitle': 'Run from source & ags CLI',
      'install.cliDesc':
        'Prefer auditing the code directly, building the latest workspace, or switching accounts from the terminal? Requires Node.js 22.12+.',
      'install.sourceLabel': 'Clone and launch desktop app',
      'install.cliLabel': 'Common ags CLI commands (run npm link after build)',
      'gate.title': 'Beyond the Gate',
      'gate.lead':
        'Beneath the AGI Gate, humans and agents walk together — AgentSwitcher v1.0 is only the prologue.',
      'gate.teaser':
        'A next-generation personal micro-relay built around private trust circles, zero wasted quota, and mutual help is counting down to launch.',
      'gate.summary': 'Open the gate · Read the endgame teaser',
      'gate.story':
        'Today, lending an account to a teammate still means exporting credentials while idle subscription windows quietly expire overnight. In the next chapter, anyone can run a self-controlled personal micro-relay — never a commercial pool or reseller, just private mutual aid for close friends and small teams:',
      'gate.b1':
        '**Share capacity, never credentials**: When your quota sits idle, your Mac acts as a lightweight relay so trusted teammates can borrow capacity without receiving passwords or raw JSON tokens.',
      'gate.b2':
        '**Private by default, fully under your switch**: Open only to your chosen circle; who connects, how much they can use, and external kill switches stay on your machine and revocable anytime.',
      'gate.b3':
        '**Zero wasted subscription windows**: Teammates lean on your spare window when sprinting, and you can draw on theirs when you need a boost.',
      'gate.cta': 'Star on GitHub & Watch Releases',
      'gate.footnote':
        'This teaser previews a separate product. AgentSwitcher manages accounts and quotas on your machine.',
      'footer.license': 'MIT License',
      'footer.docs': 'Account Management Docs',
    },
  };

  let currentLang = 'zh';
  let currentStageKey = 'cards';
  let lastTriggerEl = null;

  function renderRichText(element, text) {
    element.textContent = '';
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        element.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        element.appendChild(strong);
      } else {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        element.appendChild(code);
      }
      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < text.length) {
      element.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function t(key) {
    return I18N[currentLang][key] || I18N.zh[key] || '';
  }

  function detectInitialLang() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('lang');
    if (fromQuery === 'en' || fromQuery === 'zh') {
      return fromQuery;
    }
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'zh') {
        return saved;
      }
    } catch {
      // Ignore storage access errors in restricted browsers.
    }
    return 'zh';
  }

  function updateStage(stageKey) {
    const spec = STAGE_VIEWS[stageKey] || STAGE_VIEWS.cards;
    currentStageKey = stageKey in STAGE_VIEWS ? stageKey : 'cards';

    const img = document.getElementById('stageImage');
    const caption = document.getElementById('stageCaption');
    if (img) {
      img.src = `./images/${spec.file}`;
      img.alt = t(spec.altKey);
    }
    if (caption) {
      caption.textContent = t(spec.captionKey);
    }

    document.querySelectorAll('.stage-tab').forEach((btn) => {
      const active = btn.dataset.stage === currentStageKey;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
  }

  function updateFeatureCaptions() {
    document.querySelectorAll('.feature-row').forEach((row) => {
      const activeTab = row.querySelector('.pill-tab.is-active');
      const figcaption = row.querySelector('.feature-media figcaption');
      if (activeTab && figcaption && activeTab.dataset.capKey) {
        figcaption.textContent = t(activeTab.dataset.capKey);
      }
    });
  }

  function applyLanguage(lang, persist = true) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
    document.title = t('meta.title');

    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) {
      descMeta.setAttribute('content', t('meta.desc'));
    }

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const value = t(key);
      if (!value) return;
      if (value.includes('`') || value.includes('**')) {
        renderRichText(el, value);
      } else {
        el.textContent = value;
      }
    });

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      const active = btn.dataset.lang === currentLang;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    updateStage(currentStageKey);
    updateFeatureCaptions();

    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, currentLang);
      } catch {
        // Ignore storage errors.
      }
      const url = new URL(window.location.href);
      if (currentLang === 'en') {
        url.searchParams.set('lang', 'en');
      } else {
        url.searchParams.delete('lang');
      }
      window.history.replaceState(null, '', url.toString());
    }
  }

  function openLightbox(src, alt, caption, triggerEl) {
    const lightbox = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImg');
    const cap = document.getElementById('lightboxCaption');
    const closeBtn = document.getElementById('lightboxClose');
    if (!lightbox || !img || !cap) return;

    lastTriggerEl = triggerEl || document.activeElement;
    img.src = src;
    img.alt = alt || '';
    cap.textContent = caption || alt || '';
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    if (closeBtn) {
      closeBtn.focus();
    }
  }

  function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    document.body.style.overflow = '';
    if (lastTriggerEl && typeof lastTriggerEl.focus === 'function') {
      lastTriggerEl.focus();
    }
    lastTriggerEl = null;
  }

  async function hydrateLatestRelease() {
    try {
      const res = await fetch(REPO_API_LATEST, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const tag = data?.tag_name;
      if (data?.draft !== false || data.prerelease !== false || typeof tag !== 'string' ||
          !/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) ||
          data.html_url !== `${RELEASES_URL}/tag/${tag}` || !Array.isArray(data.assets)) return;
      const name = `AgentSwitcher-${tag.replace(/^v/, '')}-arm64.dmg`;
      const url = `${RELEASES_URL}/download/${tag}/${name}`;
      const asset = data.assets.find(item => item?.name === name && item.browser_download_url === url &&
        item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0);
      if (!asset) return;

      for (const id of ['heroReleaseTag', 'installVersionPill']) {
        const badge = document.getElementById(id);
        badge.textContent = tag;
        badge.hidden = false;
      }
      const install = document.getElementById('installDownloadBtn');
      install.href = url;
      install.hidden = false;
      document.getElementById('heroDownloadBtn').href = url;
      for (const [id, key] of [['heroActionLabel', 'install.downloadDirect'], ['releaseMeta', 'install.dmgDirectMeta']]) {
        const label = document.getElementById(id);
        label.dataset.i18n = key;
        label.textContent = t(key);
      }
    } catch {
      // The static release-history link remains usable offline or when the API is rate-limited.
    }
  }

  function bindEvents() {
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyLanguage(btn.dataset.lang || 'zh', true);
      });
    });

    document.querySelectorAll('.stage-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        updateStage(btn.dataset.stage || 'cards');
      });
    });

    document.querySelectorAll('.feature-row').forEach((row) => {
      const img = row.querySelector('.feature-media img');
      const caption = row.querySelector('.feature-media figcaption');
      row.querySelectorAll('.pill-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          row.querySelectorAll('.pill-tab').forEach((item) => {
            const active = item === tab;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-selected', String(active));
          });
          if (img && tab.dataset.shot) {
            img.src = `./images/${tab.dataset.shot}`;
          }
          if (caption && tab.dataset.capKey) {
            caption.textContent = t(tab.dataset.capKey);
            if (img) img.alt = caption.textContent;
          }
        });
      });
    });

    const stageImg = document.getElementById('stageImage');
    const stageZoomBtn = document.getElementById('stageZoomBtn');
    const openStageLightbox = (trigger) => {
      if (!stageImg) return;
      const cap = document.getElementById('stageCaption');
      openLightbox(stageImg.src, stageImg.alt, cap ? cap.textContent : '', trigger);
    };
    if (stageImg) {
      stageImg.addEventListener('click', () => openStageLightbox(stageImg));
    }
    if (stageZoomBtn) {
      stageZoomBtn.addEventListener('click', () => openStageLightbox(stageZoomBtn));
    }

    document.querySelectorAll('img[data-zoomable="true"]').forEach((img) => {
      img.addEventListener('click', () => {
        const fig = img.closest('figure');
        const cap = fig ? fig.querySelector('figcaption') : null;
        openLightbox(img.src, img.alt, cap ? cap.textContent : '', img);
      });
    });

    document.querySelectorAll('[data-close-lightbox="true"]').forEach((el) => {
      el.addEventListener('click', closeLightbox);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeLightbox();
      }
    });

    document.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy');
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          btn.classList.add('is-copied');
          btn.textContent = t('common.copied');
          window.setTimeout(() => {
            btn.classList.remove('is-copied');
            btn.textContent = t('common.copy');
          }, 1600);
        } catch {
          // Clipboard may be unavailable in insecure file:// contexts.
        }
      });
    });
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    bindEvents();
    applyLanguage(detectInitialLang(), false);
    hydrateLatestRelease();
  }
})();
