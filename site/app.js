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

  // Captions and feedback first shown after interaction. Static Chinese copy lives in the HTML.
  const chinese = {
    'common.copied': '已复制',
    'stage.capRows': '紧凑单行视图，按套餐密集对齐比较多个账号的 5h / 7d 余量与 Credits。',
    'stage.capAgy': '以 Gemini 为主额度并独立展示 Claude / GPT 模型组，缺失值如实显示「—」。',
    'stage.capSettings': '可调整显示和登录偏好、导出脱敏故障报告，以及检查应用更新。',
    'stage.altRows': 'Codex 单行视图：按套餐比较多个账号的额度',
    'stage.altAgy': 'Antigravity：当前与备用账号的模型组额度',
    'stage.altSettings': '设置：紧凑的偏好、清理辅助与应用更新',
    'f1.cap2': 'Gemini 和 Claude / GPT 的额度分别显示。暂时无法更新时，可在账号详情查看原因和上次成功时间。',
    'f2.cap2': '批量导入前可逐条筛选、改名、按身份去重并原位更新过期凭据。',
    'f3.cap2': '移除前先摊开核对同身份备份数量，退出客户端登录默认不勾选，由你主动决定。',
    'install.choose': '请选择与系统和处理器匹配的安装包。',
    'meta.title': document.title,
    'meta.desc': document.querySelector('meta[name="description"]')?.content,
    'stage.altCards': document.getElementById('stageImage')?.alt,
  };
  for (const element of document.querySelectorAll('[data-i18n]')) {
    chinese[element.dataset.i18n] = [...element.childNodes].map(node => {
      if (node.nodeName === 'STRONG') return '**' + node.textContent + '**';
      if (node.nodeName === 'CODE') return '`' + node.textContent + '`';
      return node.textContent;
    }).join('').trim();
  }
  const english = {
    'meta.title': 'AgentSwitcher · AGS — Multi-Account & Quota Manager for AI Coding Agents',
    'meta.desc':
      'Manage personal, team, and borrowed Codex & Antigravity accounts in one desktop window. Compare remaining quotas at a glance and switch safely — local-first, AES-256-GCM encrypted, zero backend.',
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
      'Whether you juggle personal and team accounts or borrow a teammate’s Codex or Antigravity account in a crunch — keep them in one desktop window, see who still has quota left, and switch without breaking flow or overwriting an unsaved primary login.',
    'hero.download': 'Choose an installer',
    'hero.source': 'View Source on GitHub',
    'hero.fact1': 'macOS · Windows',
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
      'On Mac, click the AGS menu bar icon to check your current quota and choose a backup account.',
    'f1.title': 'Check quota without guessing',
    'f1.desc':
      'Your active account stays pinned on top while backups are grouped by plan and sorted by remaining availability in Card or Row view. Codex separates 5h / 7d windows and Credits; Antigravity leads with Gemini and keeps Claude / GPT model groups independent without blending percentages.',
    'f1.tab1': 'Codex Row View',
    'f1.tab2': 'Antigravity Hierarchy',
    'f1.cap1': 'Tightly aligned single-row table built for comparing many accounts across 5h / 7d windows and Credits.',
    'f1.cap2': 'Gemini and Claude / GPT quotas are shown separately. If a refresh is delayed, account details show why and when the last refresh succeeded.',
    'f2.title': 'Add accounts without signing out',
    'f2.desc':
      'Sign in through your browser and add accounts in succession while your current client stays signed in. Preview, rename and deduplicate accounts before importing JSON. You can update expired credentials after identity verification and keep the account nickname.',
    'f2.tab1': 'Isolated Browser Login',
    'f2.tab2': 'Batch Import Preview',
    'f2.cap1': 'For private sign-in, AGS can open a private window in a supported Mac browser. On Windows it copies the link for you to paste into a private window.',
    'f2.cap2': 'Review every entry before import: select, rename, deduplicate by identity, and update expired tokens in place.',
    'f3.title': 'Back up and remove without collateral damage',
    'f3.desc':
      'Select accounts and set a password of at least 6 characters to export an encrypted .ags backup that you can restore on another computer. Review which accounts will be removed. By default, your client stays signed in and your chat history and project files are preserved.',
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
      'Sign-in is limited to official OpenAI and Google authorization domains. Diagnostic records stay on your device. You can export a redacted report from Settings and share it with a maintainer.',
    'security.p2Title': 'Local credential encryption',
    'security.p2Desc':
      'AGS encrypts stored credentials with `AES-256-GCM`. macOS Keychain or Windows DPAPI protects the master key for the current user. Exported `.ags` backups use a separate password.',
    'security.p3Title': 'No silent overwrites or side effects',
    'security.p3Desc':
      'Unsaved active logins trigger a protection prompt before switching. AGS swaps login credentials only — never touching chat history, project settings, or auto-switching in the background.',
    'security.p4Title': 'Clear local-only scope',
    'security.p4Desc':
      'Only store accounts you own or have explicit permission to use. This release is strictly local to your device with no online relay or account sharing.',
    'support.title': 'Supported platforms',
    'support.colPlatform': 'Platform',
    'support.colStatus': 'Status',
    'support.colDetail': 'Capabilities & requirements',
    'support.ready': 'Supported',
    'support.codexDesc':
      'Requires the official Codex CLI. Supports isolated sign-in, switching via auth.json, 5h and 7d quotas, and Credits. Keychain-only logins are unsupported. API keys have no subscription quota.',
    'support.agyDesc':
      'Antigravity 2.x on macOS supports signing in, saving and switching personal Google accounts, and checking quotas by model group. Requires the official agy CLI. Enterprise authentication is unverified.',
    'support.foot': 'Both 0.1.0 Mac builds launched on their respective architectures, and the Windows x64 installer passed installation, launch, and uninstall checks. On Mac, a personal Antigravity account refreshed its quota across two token expirations while the desktop app stayed open. Two-account round trips on Mac and real-device end-to-end checks on Windows still await independent verification.',
    'install.title': 'Download & quick install',
    'install.subtitle':
      'Mac requires macOS 13 or later. Use the one-line terminal command to auto-detect your chip and verify the install, or download an installer directly. Once installed, both macOS and Windows x64 support one-click updates in Settings → App & Updates.',
    'install.desktopTitle': 'One-line install & desktop packages',
    'install.releaseFallback': 'Copy a one-line install command below, or see GitHub Releases for installers.',
    'install.choose': 'Use a one-line install command or choose the package for your system.',
    'install.macCmdLabel': 'macOS Terminal one-line install (auto-detects chip & verifies manifest)',
    'install.winCmdLabel': 'Windows PowerShell one-line install (x64)',
    'install.allReleases': 'All releases & notes',
    'install.gatekeeperTitle': 'Manual DMG download says the developer cannot be verified?',
    'install.gatekeeperDesc':
      'Mac builds are ad-hoc signed and not yet Apple notarized. The terminal command above verifies the signed manifest automatically; if dragging a DMG manually, check SHA256SUMS and choose Open Anyway in System Settings → Privacy & Security.',
    'install.verifyLabel': 'Manual download: compare the output with SHA256SUMS',
    'install.cliTitle': 'Run from source & ags CLI',
    'install.cliDesc':
      'Prefer auditing the code directly, building the latest workspace, or switching accounts from the terminal? Requires Node.js 22.12+.',
    'install.sourceLabel': 'Clone and launch desktop app',
    'install.cliLabel': 'Common ags CLI commands (run npm link after build)',
    'gate.title': 'Beyond the Gate',
    'gate.lead':
      'Beneath the AGI Gate, humans and agents walk together — AgentSwitcher is only the prologue.',
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
    return (currentLang === 'en' ? english[key] : chinese[key]) || '';
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
      const version = tag.replace(/^v/, '');
      if (version === '1.0.0' || version === '1.0.1') return;
      const installers = {
        macArmDownload: `AgentSwitcher-${version}-arm64.dmg`,
        macIntelDownload: `AgentSwitcher-${version}-x64.dmg`,
        windowsDownload: `AgentSwitcher-Setup-${version}-x64.exe`,
      };
      let available = false;
      for (const [id, name] of Object.entries(installers)) {
        const url = `${RELEASES_URL}/download/${tag}/${name}`;
        const uploaded = data.assets.some(item => item?.name === name && item.browser_download_url === url &&
          item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0);
        if (!uploaded) continue;
        const link = document.getElementById(id);
        link.href = url;
        link.hidden = false;
        available = true;
      }
      if (!available) return;
      for (const id of ['heroReleaseTag', 'installVersionPill']) {
        const badge = document.getElementById(id);
        badge.textContent = tag;
        badge.hidden = false;
      }
      const label = document.getElementById('releaseMeta');
      label.dataset.i18n = 'install.choose';
      label.textContent = t('install.choose');
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
