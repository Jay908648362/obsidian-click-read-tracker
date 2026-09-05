/* =========================================================================
 * Click Read Tracker — Obsidian 点击/已读 + 审核状态追踪插件（v1.4.0）
 * ---------------------------------------------------------------------------
 * 设计原则：
 *   1. 「审核」唯一字段 = 笔记 frontmatter 的 reviewed（只【读】不【写】）。
 *   2. 「读过/点过」状态只存插件自身 data.json，不写笔记 YAML。
 *   3. 本插件自己读目标笔记 reviewed 注入 data-reviewed，并注入 data-read，
 *      交给 review-status.css 着色。不依赖 Supercharged Links 配置。
 *
 * v1.3.0 修复：正文 [[链接]] 只有「一部分」生效。
 *   根因 A：原解析只按文件名反查，按「标题/H1/别名」写的链接解析不到 → 不标。
 *           改为多路兜底 + H1标题 + 别名 + 大小写不敏感。
 *   根因 B：Live Preview 对视口外链接惰性渲染（滚动到才变 a.internal-link）。
 *           改为监听滚动 + 打开笔记后多次延迟重装饰，确保全部渲染后都标上。
 *   增强：调试命令改为「弹通知」显示关键数字，无需开 Console。
 *
 * v1.4.0 修复：标准 Markdown 链接 [文本](路径.md) 不生效（如索引 MOC 的「主题速览」）。
 *   根因：这类链接若目标不存在，Obsidian 渲染成 a.external-link（断链），
 *         而 v1.3.0 只扫 a.internal-link，全漏。
 *   改为：同时处理 a.external-link 中指向 .md 的链接；
 *         - 解析到目标 → 按 reviewed 标（与 wikilink 一致）；
 *         - 解析不到（真断链）→ 标 data-missing，CSS 显示「⚠ 缺失」，让断链可见。
 * ========================================================================= */

const { Plugin, Notice, TFile } = require('obsidian');

const STORAGE_KEY = 'read';

module.exports = class ClickReadTracker extends Plugin {
  async onload() {
    const data = await this.loadData();
    this.readPaths = new Set((data && data[STORAGE_KEY]) || []);
    this.tracking = true;
    this._raf = null;

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && this.tracking) this.markRead(file.path);
        this.delayedDecorate(); // 打开后分波重装饰，吃掉 Lazy Preview 的滞后渲染
      })
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.scheduleDecorate())
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.scheduleDecorate())
    );
    this.registerEvent(
      this.app.workspace.on('editor-change', () => this.scheduleDecorate())
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', () => this.scheduleDecorate())
    );

    // 滚动时重装饰：Live Preview 滚动到视口才会把 [[链接]] 渲染成 a.internal-link
    const onScroll = () => this.scheduleDecorate();
    document.addEventListener('scroll', onScroll, true);
    this.register(() => document.removeEventListener('scroll', onScroll, true));

    this.observer = new MutationObserver(() => this.scheduleDecorate());
    this.register(() => this.observer.disconnect());

    this.app.workspace.onLayoutReady(() => {
      this.observer.observe(document.body, { childList: true, subtree: true });
      this.decorate();
    });

    this.addCommand({
      id: 'click-read-tracker-reset',
      name: '清除全部「已读」记录（重置）',
      callback: () => {
        this.readPaths.clear();
        this.saveData({ [STORAGE_KEY]: [] }).then(() => {
          this.decorate();
          new Notice('Click Read Tracker：已清除全部已读记录');
        });
      },
    });

    // 调试：重新装饰并【弹通知】显示统计（不再需要开 Console）
    this.addCommand({
      id: 'click-read-tracker-debug',
      name: '调试：重新装饰并打印统计',
      callback: () => {
        const stat = this.decorate(true);
        new Notice(
          `ClickReadTracker 调试 → 正文链接 ${stat.linksTotal}（已解析 ${stat.linksResolved}｜缺失 ${stat.linksMissing}）｜已审 ${stat.linksReviewedTrue} / 未审 ${stat.linksReviewedFalse} / 看过 ${stat.linksRead}｜左栏 ${stat.navTotal}`,
          8000
        );
        console.log('[ClickReadTracker]', stat);
      },
    });
  }

  markRead(path) {
    if (!path || this.readPaths.has(path)) return;
    this.readPaths.add(path);
    this.saveData({ [STORAGE_KEY]: Array.from(this.readPaths) });
    this.scheduleDecorate();
  }

  // 打开笔记后分波重装饰（50/200/500ms），覆盖 Live Preview 的渐进渲染
  delayedDecorate() {
    [50, 200, 500, 1000].forEach((ms) =>
      setTimeout(() => this.scheduleDecorate(), ms)
    );
  }

  scheduleDecorate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.decorate(false);
    });
  }

  reviewedOf(path) {
    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm && typeof fm.reviewed === 'boolean') return fm.reviewed;
    return null;
  }

  // 多路兜底：把 [[链接]] 的 linkpath 解析成笔记路径
  // 覆盖：标准反查(别名) / 文件名 / 别名 / H1标题 / 完整路径 / 模糊路径；大小写不敏感
  buildResolver() {
    const app = this.app;
    const cache = app.metadataCache;
    const sourcePath = app.workspace.getActiveFile()?.path || '';
    const allFiles = app.vault.getMarkdownFiles();
    const norm = (s) => (s || '').trim().toLowerCase();

    const byBase = new Map();
    const byPath = new Map();
    const byHeading = new Map();
    const byAlias = new Map();

    for (const f of allFiles) {
      const b = norm(f.basename);
      if (!byBase.has(b)) byBase.set(b, f.path);
      const p = norm(f.path);
      if (!byPath.has(p)) byPath.set(p, f.path);
      const pe = norm(f.path.slice(0, -3));
      if (!byPath.has(pe)) byPath.set(pe, f.path);

      const fc = cache.getFileCache(f);
      // 第一个 H1 标题
      const h1 = fc?.headings?.find((h) => h.level === 1);
      if (h1 && h1.heading) {
        const hk = norm(h1.heading);
        if (hk && !byHeading.has(hk)) byHeading.set(hk, f.path);
      }
      // 别名（aliases 可能是字符串或数组）
      const aliases = fc?.frontmatter?.aliases;
      if (aliases) {
        const arr = Array.isArray(aliases) ? aliases : [aliases];
        for (const a of arr) {
          const ak = norm(a);
          if (ak && !byAlias.has(ak)) byAlias.set(ak, f.path);
        }
      }
    }

    return (linkpath) => {
      const raw = norm((linkpath || '').split('#')[0].split('|')[0]);
      if (!raw) return null;
      // 1) 标准反查（带源路径 / 全库）——Obsidian 内部已含别名匹配
      let f =
        cache.getFirstLinkpathDest(raw, sourcePath) ||
        cache.getFirstLinkpathDest(raw, '');
      if (f) return f.path;
      // 2) 文件名（basename，大小写不敏感）
      if (byBase.has(raw)) return byBase.get(raw);
      // 3) 别名
      if (byAlias.has(raw)) return byAlias.get(raw);
      // 4) H1 标题
      if (byHeading.has(raw)) return byHeading.get(raw);
      // 5) 完整路径 / 带扩展名路径
      if (byPath.has(raw)) return byPath.get(raw);
      // 6) 模糊：路径结尾匹配
      const hit = allFiles.find(
        (mf) =>
          norm(mf.path) === raw + '.md' ||
          mf.path.toLowerCase().endsWith('/' + raw) ||
          mf.path.toLowerCase().endsWith('/' + raw + '.md')
      );
      return hit ? hit.path : null;
    };
  }

  decorate(debug = false) {
    const app = this.app;
    if (!app) return null;
    const resolve = this.buildResolver();
    const stat = {
      linksTotal: 0,
      linksResolved: 0,
      linksReviewedTrue: 0,
      linksReviewedFalse: 0,
      linksRead: 0,
      linksMissing: 0,
      navTotal: 0,
      navReviewedTrue: 0,
      navReviewedFalse: 0,
      navRead: 0,
    };

    // 统一处理一条链接（wikilink 或 Markdown 链接）：解析→标 reviewed/read/缺失
    const handleLink = (el) => {
      stat.linksTotal++;
      const raw = el.getAttribute('data-href') || el.getAttribute('href') || '';
      const p = resolve(raw);
      el.removeAttribute('data-missing'); // 先清，避免旧状态残留

      if (p) {
        stat.linksResolved++;
        // 解析到目标 → 按 reviewed 标（字段缺失也按「未审」处理，保证全部有标识）
        const rev = this.reviewedOf(p);
        if (rev === true) {
          el.setAttribute('data-reviewed', 'true');
          stat.linksReviewedTrue++;
        } else {
          el.setAttribute('data-reviewed', 'false');
          stat.linksReviewedFalse++;
        }
        if (this.readPaths.has(p)) {
          el.setAttribute('data-read', 'true');
          stat.linksRead++;
        } else {
          el.removeAttribute('data-read');
        }
      } else {
        // 解析不到（断链）→ 不强行标 reviewed
        el.removeAttribute('data-reviewed');
        el.removeAttribute('data-read');
        // 仅对「指向 .md 却解析不到」的 vault 内断链标缺失；真外部 URL 不标
        if (/\.md$/i.test(raw)) {
          el.setAttribute('data-missing', 'true');
          stat.linksMissing++;
        }
      }
    };

    // wikilink（解析得到的多为 internal-link）
    document.querySelectorAll('a.internal-link[data-href]').forEach(handleLink);
    // 标准 Markdown 链接 [文本](路径.md)：目标存在→internal-link，不存在→external-link（断链）
    document.querySelectorAll('a.external-link[data-href]').forEach((el) => {
      const raw = el.getAttribute('data-href') || el.getAttribute('href') || '';
      if (/\.md$/i.test(raw)) handleLink(el); // 只处理 vault 内 .md 链接，真外链（http）跳过
    });

    document.querySelectorAll('.nav-file-title[data-path]').forEach((el) => {
      stat.navTotal++;
      const p = el.getAttribute('data-path');
      const rev = this.reviewedOf(p);
      if (rev === true) {
        el.setAttribute('data-reviewed', 'true');
        stat.navReviewedTrue++;
      } else if (rev === false) {
        el.setAttribute('data-reviewed', 'false');
        stat.navReviewedFalse++;
      } else {
        el.removeAttribute('data-reviewed');
      }
      if (p && this.readPaths.has(p)) {
        el.setAttribute('data-read', 'true');
        stat.navRead++;
      } else {
        el.removeAttribute('data-read');
      }
    });

    if (debug) return stat;
    return null;
  }

  onunload() {
    if (this._raf) cancelAnimationFrame(this._raf);
  }
};
