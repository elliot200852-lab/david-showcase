/**
 * build-index.js — Cloud Design 版部署管線
 *
 * 流程：
 *   1. 載入 site/data.js（curated 中繼資料：每分類的 id/title/subtitle/note/accent + 每檔 desc）
 *   2. 掃描 Drive ROOT_FOLDER 下所有 NN_* 子資料夾與其 HTML 檔案
 *   3. Merge：以 Drive 為實際真相，補上 modifiedTime → date、size → size
 *      - 既有條目：更新 date / size
 *      - Drive 新增檔案：自動加入（auto-parsed title + 空 desc，待後補）
 *      - data.js 有但 Drive 沒有：保留並在 build-report 提示
 *      - Drive 新資料夾未在 data.js：跳過（需先手動建中繼資料）
 *   4. 下載 HTML 檔到 output/files/<folder>/<file>
 *   5. 輸出：
 *        output/index.html      ← 自 site/ 複製
 *        output/category.html   ← 自 site/ 複製
 *        output/styles.css      ← 自 site/ 複製
 *        output/data.js         ← merged 結果
 *        output/build-report.md ← 同步差異報告
 */

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT_FOLDER_ID = '1rK3Eq8LH2Sg9YRBUcPA6PzQhDzVckLCq';
const REPO_ROOT      = path.resolve(__dirname, '..');
const SITE_DIR       = path.join(REPO_ROOT, 'site');
const OUTPUT_DIR     = path.join(REPO_ROOT, 'output');
const FILES_DIR      = path.join(OUTPUT_DIR, 'files');

// ─── Auth ────────────────────────────────────────────────────
async function getDriveClient() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } else {
    const keyPath = path.join(REPO_ROOT, 'service-account-key.json');
    if (!fs.existsSync(keyPath)) {
      console.error('No service account key. Set GOOGLE_SERVICE_ACCOUNT_KEY or provide service-account-key.json');
      process.exit(1);
    }
    credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// ─── Drive listing ──────────────────────────────────────────
async function listSubfolders(drive, parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    orderBy: 'name',
    pageSize: 100,
  });
  return res.data.files || [];
}

async function listHtmlFiles(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='text/html' and trashed=false`,
      fields: 'nextPageToken, files(id, name, size, modifiedTime)',
      orderBy: 'name',
      pageSize: 100,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  fs.writeFileSync(destPath, Buffer.from(res.data));
}

// ─── Helpers ─────────────────────────────────────────────────
function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatSize(bytes) {
  const n = parseInt(bytes || '0', 10);
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

// 由檔名 fallback 出標題：去 .html、去 V1/拷貝/校準版 等贅字、底線/連字號轉空白
function parseTitleFromFilename(filename) {
  let name = filename.replace(/\.html$/i, '');
  name = name.replace(/[-_]*(v\d+(\.\d+)?|完整版|美化版|full|校準版|拷貝)[-_]*/gi, '');
  name = name.replace(/[-_]+/g, ' ').trim();
  return name || filename;
}

// 載入 site/data.js 並取出 META / CATEGORIES / BASE_URL
// 注意：vm context 不暴露 const 宣告，所以在跑完後手動把變數推進 globalThis
function loadCuratedData() {
  const code = fs.readFileSync(path.join(SITE_DIR, 'data.js'), 'utf8');
  // 抽掉檔尾的 window.DATA expose 與 urlFor（Node 沒有 window，function 我們自己重寫）
  const stripped = code.replace(/window\.DATA\s*=[\s\S]*$/, '');
  // 在 vm 內用 globalThis.X = X 把 const 變數推出來
  const exposeTail = `\n;Object.assign(globalThis, { META, CATEGORIES, BASE_URL });`;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(stripped + exposeTail, sandbox);
  return {
    META: sandbox.META,
    CATEGORIES: sandbox.CATEGORIES,
    BASE_URL: sandbox.BASE_URL,
  };
}

// ─── Merge curated + drive ──────────────────────────────────
function mergeData(curated, driveData) {
  const report = { newFiles: [], missingFiles: [], unknownFolders: [], updatedFiles: 0 };

  // 建 folder → curatedCategory 映射
  const curatedByFolder = new Map();
  for (const cat of curated.CATEGORIES) {
    curatedByFolder.set(cat.folder, cat);
  }

  // 建 folder → driveFiles 映射
  const driveByFolder = new Map();
  for (const f of driveData) {
    driveByFolder.set(f.name, f.files);
  }

  // 遍歷 curated categories，更新每個 item 的 date/size
  for (const cat of curated.CATEGORIES) {
    const driveFiles = driveByFolder.get(cat.folder);
    if (!driveFiles) {
      // 整個 folder 在 Drive 沒了
      cat.items.forEach(it => report.missingFiles.push(`${cat.folder}/${it.file}`));
      continue;
    }
    const driveByName = new Map(driveFiles.map(f => [f.name, f]));

    // 更新既有條目
    for (const item of cat.items) {
      const df = driveByName.get(item.file);
      if (df) {
        item.date = formatDate(df.modifiedTime);
        item.size = formatSize(df.size);
        report.updatedFiles++;
        driveByName.delete(item.file); // 標記已處理
      } else {
        report.missingFiles.push(`${cat.folder}/${item.file}`);
      }
    }

    // 剩下的就是 Drive 新增、data.js 還沒寫入的檔案
    for (const [name, df] of driveByName) {
      const newItem = {
        title: parseTitleFromFilename(name),
        date: formatDate(df.modifiedTime),
        size: formatSize(df.size),
        desc: '（待補：請至 site/data.js 為此檔案補上一句敘述）',
        file: name,
      };
      cat.items.push(newItem);
      report.newFiles.push(`${cat.folder}/${name}`);
    }
  }

  // 找出 Drive 有、curated 沒有的整個資料夾
  for (const f of driveData) {
    if (!curatedByFolder.has(f.name) && f.files.length > 0) {
      report.unknownFolders.push(f.name);
    }
  }

  return { curated, report };
}

// ─── Output writers ─────────────────────────────────────────
function writeDataJs(curated) {
  const out = `// David 素材展示 · 資料層（由 scripts/build-index.js 自動生成）
// curated 中繼資料在 site/data.js；Drive 上的 date/size 由 build 同步寫入
// 新增檔案會自動帶入（title 由檔名 parse、desc 留空待補）

const BASE_URL = ${JSON.stringify(curated.BASE_URL)};

const META = ${JSON.stringify(curated.META, null, 2)};

const CATEGORIES = ${JSON.stringify(curated.CATEGORIES, null, 2)};

// ---- Sort items within each category by date (newest first) ----
CATEGORIES.forEach(cat => {
  cat.items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  cat.latestDate = cat.items[0]?.date || '';
});

// ---- Sort categories by their most recent upload, newest first ----
CATEGORIES.sort((a, b) => {
  const d = (b.latestDate || '').localeCompare(a.latestDate || '');
  if (d !== 0) return d;
  return a.folder.localeCompare(b.folder);
});

// ---- Reassign display numerals 01..NN based on new sort order ----
CATEGORIES.forEach((cat, i) => {
  cat.num = String(i + 1).padStart(2, '0');
});

// ---- Update META.updated with the freshest item date across all categories ----
const _allDates = CATEGORIES.flatMap(c => c.items.map(i => i.date)).filter(Boolean).sort();
if (_allDates.length) {
  META.updated = _allDates[_allDates.length - 1];
}

// Helper: build encoded URL for a file
function urlFor(category, item) {
  return BASE_URL + encodeURI(category.folder + '/' + item.file);
}

// Expose to window
window.DATA = { META, CATEGORIES, urlFor };
`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'data.js'), out);
}

function writeBuildReport(report, totalCategories, totalFiles) {
  const lines = [
    '# build-index 部署報告',
    '',
    `產生於 ${new Date().toISOString()}`,
    '',
    `## 摘要`,
    `- 分類數：${totalCategories}`,
    `- 同步檔案數：${report.updatedFiles}`,
    `- 新增（Drive 有、curated 沒）：${report.newFiles.length}`,
    `- 缺漏（curated 有、Drive 沒）：${report.missingFiles.length}`,
    `- 未知資料夾（Drive 有、未在 data.js）：${report.unknownFolders.length}`,
    '',
  ];

  if (report.newFiles.length) {
    lines.push('## 🆕 自動加入（請至 site/data.js 補 desc）');
    report.newFiles.forEach(p => lines.push(`- \`${p}\``));
    lines.push('');
  }
  if (report.missingFiles.length) {
    lines.push('## ⚠️ 缺漏（curated 有、Drive 沒）');
    report.missingFiles.forEach(p => lines.push(`- \`${p}\``));
    lines.push('');
  }
  if (report.unknownFolders.length) {
    lines.push('## 🚫 未知資料夾（須先在 site/data.js 建中繼資料）');
    report.unknownFolders.forEach(p => lines.push(`- \`${p}\``));
    lines.push('');
  }
  if (report.linkRewrites && report.linkRewrites.length) {
    lines.push('## 🔗 連結改寫（依 site/link-rewrites.json）');
    report.linkRewrites.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'build-report.md'), lines.join('\n'));
}

function copyStaticAssets() {
  for (const f of ['index.html', 'category.html', 'styles.css']) {
    fs.copyFileSync(path.join(SITE_DIR, f), path.join(OUTPUT_DIR, f));
  }
}

// ─── Per-folder href rewrites ───────────────────────────────
// 修正 Drive 上傳的 HTML 內、指向不存在 sibling 檔的 href（例如
// pandoc 從 .md 轉 HTML 時把章節間 prev/next 留作 .md 兄弟檔，但 deploy
// 下只有 .html）。對照表見 site/link-rewrites.json。
function loadLinkRewrites() {
  const p = path.join(SITE_DIR, 'link-rewrites.json');
  if (!fs.existsSync(p)) return {};
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete raw._doc;
  return raw;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteLinks(content, rewrites) {
  let modified = content;
  let count = 0;
  for (const [from, to] of Object.entries(rewrites)) {
    // encodeURI preserves `&`; some tools URL-encode it to `%26`, others emit
    // the HTML entity `&amp;`. Try all three so we hit every dialect pandoc
    // and friends produce.
    const enc = encodeURI(from);
    const variants = new Set([
      from,
      enc,
      enc.replace(/&/g, '%26'),
      from.replace(/&/g, '&amp;'),
      enc.replace(/&/g, '&amp;'),
    ]);
    for (const v of variants) {
      const re = new RegExp(`href="${escapeRegex(v)}(#[^"]*)?"`, 'g');
      modified = modified.replace(re, (_m, frag) => {
        count++;
        return `href="${to}${frag || ''}"`;
      });
    }
  }
  return { content: modified, count };
}

function applyLinkRewritesPerFolder(folderName, folderDir, linkRewrites) {
  const rules = linkRewrites[folderName];
  if (!rules) return { filesChanged: 0, totalLinks: 0, perFile: [] };
  let filesChanged = 0, totalLinks = 0;
  const perFile = [];
  for (const fname of fs.readdirSync(folderDir)) {
    if (!fname.toLowerCase().endsWith('.html')) continue;
    const fp = path.join(folderDir, fname);
    const orig = fs.readFileSync(fp, 'utf8');
    const { content: fixed, count } = rewriteLinks(orig, rules);
    if (count > 0) {
      fs.writeFileSync(fp, fixed);
      filesChanged++;
      totalLinks += count;
      perFile.push(`${folderName}/${fname}: ${count} link(s)`);
    }
  }
  return { filesChanged, totalLinks, perFile };
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(FILES_DIR, { recursive: true });

  console.log('📦 載入 site/data.js（curated 中繼資料）...');
  const curated = loadCuratedData();
  console.log(`   ${curated.CATEGORIES.length} 個分類, ${curated.CATEGORIES.reduce((s,c) => s+c.items.length, 0)} 件素材`);

  console.log('☁️  連線 Google Drive...');
  const drive = await getDriveClient();

  console.log('📁 列出子資料夾...');
  const subfolders = await listSubfolders(drive, ROOT_FOLDER_ID);
  console.log(`   發現 ${subfolders.length} 個子資料夾`);

  console.log('📋 列出每個資料夾的 HTML 檔案...');
  const driveData = [];
  for (const folder of subfolders) {
    const files = await listHtmlFiles(drive, folder.id);
    driveData.push({ id: folder.id, name: folder.name, files });
    console.log(`   [${folder.name}] ${files.length} 檔`);
  }

  console.log('🔄 合併 curated + Drive...');
  const { curated: merged, report } = mergeData(curated, driveData);

  console.log('⬇️  下載 HTML 檔案到 output/files/...');
  for (const f of driveData) {
    const folderDir = path.join(FILES_DIR, f.name);
    fs.mkdirSync(folderDir, { recursive: true });
    for (const file of f.files) {
      const destPath = path.join(folderDir, file.name);
      const sizeMB = (parseInt(file.size || '0', 10) / 1024 / 1024).toFixed(2);
      console.log(`   ↓ ${f.name}/${file.name} (${sizeMB} MB)`);
      await downloadFile(drive, file.id, destPath);
    }
  }

  console.log('🔗 套用 link-rewrites（修正 pandoc 殘留的 .md 兄弟檔連結）...');
  const linkRewrites = loadLinkRewrites();
  const rewriteSummary = [];
  for (const f of driveData) {
    const folderDir = path.join(FILES_DIR, f.name);
    const r = applyLinkRewritesPerFolder(f.name, folderDir, linkRewrites);
    if (r.totalLinks > 0) {
      console.log(`   ✎ ${f.name}: 改寫 ${r.filesChanged} 檔 / ${r.totalLinks} 連結`);
      rewriteSummary.push(...r.perFile);
    }
  }
  if (rewriteSummary.length === 0) {
    console.log('   (無連結需要改寫)');
  }

  console.log('📝 產出 output/data.js + 複製靜態檔案...');
  writeDataJs(merged);
  copyStaticAssets();

  const totalFiles = merged.CATEGORIES.reduce((s, c) => s + c.items.length, 0);
  report.linkRewrites = rewriteSummary;
  writeBuildReport(report, merged.CATEGORIES.length, totalFiles);

  console.log(`\n✓ Build 完成`);
  console.log(`   ${merged.CATEGORIES.length} 分類, ${totalFiles} 件素材`);
  if (rewriteSummary.length) console.log(`   🔗 link-rewrites: ${rewriteSummary.length} 檔被改寫`);
  if (report.newFiles.length) console.log(`   🆕 ${report.newFiles.length} 個新檔自動上架（請補 desc）`);
  if (report.missingFiles.length) console.log(`   ⚠️  ${report.missingFiles.length} 個檔案在 Drive 找不到`);
  if (report.unknownFolders.length) console.log(`   🚫 ${report.unknownFolders.length} 個未知資料夾被跳過`);
}

main().catch(err => {
  console.error('build-index failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
