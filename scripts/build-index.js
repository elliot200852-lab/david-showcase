/**
 * build-index.js — Download HTML files from Google Drive (with subfolder support)
 *                  and generate a folder-organised index page.
 *
 * Drive layout expected:
 *   ROOT_FOLDER/
 *     01_9C英文課程/    ← subfolders
 *     02_9C走讀台南/
 *     …
 *
 * Output:
 *   output/index.html                    ← index with per-folder sections
 *   output/files/{folderSlug}/{file}     ← downloaded HTML files
 */

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const ROOT_FOLDER_ID = '1rK3Eq8LH2Sg9YRBUcPA6PzQhDzVckLCq';
const OUTPUT_DIR     = path.resolve(__dirname, '..', 'output');
const FILES_DIR      = path.join(OUTPUT_DIR, 'files');

// ─── Auth ────────────────────────────────────────────────────
async function getDriveClient() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } else {
    const keyPath = path.join(__dirname, '..', 'service-account-key.json');
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

// ─── List subfolders ─────────────────────────────────────────
async function listSubfolders(drive, parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    orderBy: 'name',
    pageSize: 50,
  });
  return res.data.files || [];
}

// ─── List HTML files in a folder ─────────────────────────────
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

// ─── Download ────────────────────────────────────────────────
async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  fs.writeFileSync(destPath, Buffer.from(res.data));
}

// ─── Helpers ─────────────────────────────────────────────────
function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-');
}

// Strip numbering prefix: "01_9C英文課程" → "9C英文課程"
function folderDisplayName(raw) {
  return raw.replace(/^\d+[_\-\s]+/, '');
}

function parseDisplayName(filename) {
  let name = filename.replace(/\.html$/i, '');
  name = name.replace(/[-_]*(v\d+(\.\d+)?|完整版|美化版|full|校準版|拷貝)[-_]*/gi, '');
  name = name.replace(/[-_]+/g, ' ').trim();
  return name || filename;
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const FOLDER_ICONS = {
  '9C英文': 'menu_book',
  '走讀':   'map',
  '歷史':   'history_edu',
  '五年級': 'eco',
  '台灣的故事': 'auto_stories',
  '工作坊': 'build',
  'TeacherOS': 'settings',
  '3A':     'calculate',
};

function folderIcon(displayName) {
  for (const [key, icon] of Object.entries(FOLDER_ICONS)) {
    if (displayName.includes(key)) return icon;
  }
  return 'folder_open';
}

// ─── HTML generation ─────────────────────────────────────────
function generateIndex(sections) {
  const totalFiles = sections.reduce((s, f) => s + f.files.length, 0);
  const now = new Date().toISOString().split('T')[0];

  const navItems = sections.map(sec =>
    `<a href="#${sec.slug}" class="nav-chip font-label text-xs px-3 py-1.5 rounded-full transition-colors" style="background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.85)">${esc(sec.displayName)}</a>`
  ).join('\n        ');

  const folderSections = sections.map(sec => {
    const icon = folderIcon(sec.displayName);
    const cards = sec.files.map(file => {
      const displayName = parseDisplayName(file.name);
      const date = formatDate(file.modifiedTime);
      const sizeKB = Math.round(parseInt(file.size || '0', 10) / 1024);
      const localFile = safeFilename(file.name);
      const href = `files/${encodeURIComponent(sec.slug)}/${encodeURIComponent(localFile)}`;
      return `
        <a href="${href}" class="card-hover block rounded-xl overflow-hidden bg-white shadow-sm">
          <div class="p-5">
            <div class="flex items-start gap-3">
              <span class="material-symbols-outlined mt-0.5 shrink-0" style="color:var(--primary);font-size:1.3rem">description</span>
              <div class="min-w-0 flex-1">
                <h3 class="font-headline text-base font-bold leading-snug mb-1.5" style="color:var(--on-surface)">${esc(displayName)}</h3>
                <div class="flex items-center gap-3 text-xs" style="color:var(--on-surface-variant)">
                  <span class="flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:0.9rem">schedule</span>${date}</span>
                  <span>${sizeKB} KB</span>
                </div>
              </div>
              <span class="material-symbols-outlined ml-auto shrink-0" style="color:var(--outline-variant);font-size:1.2rem">open_in_new</span>
            </div>
          </div>
        </a>`;
    }).join('\n');

    return `
  <section id="${sec.slug}" class="mb-12">
    <div class="flex items-center gap-3 mb-5 pb-3" style="border-bottom:2px solid var(--bg-wash-2)">
      <span class="material-symbols-outlined" style="color:var(--primary);font-size:1.6rem">${icon}</span>
      <h2 class="font-headline text-xl font-bold" style="color:var(--on-surface)">${esc(sec.displayName)}</h2>
      <span class="ml-auto text-xs font-label px-2 py-0.5 rounded-full" style="background:var(--bg-wash-2);color:var(--on-surface-variant)">${sec.files.length} 件</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
${cards}
    </div>
  </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script>
tailwind.config={theme:{extend:{fontFamily:{
  "headline":["Playfair Display","Noto Serif TC","Georgia","serif"],
  "body":["Plus Jakarta Sans","Noto Sans TC","PingFang TC","Microsoft JhengHei","sans-serif"],
  "label":["Plus Jakarta Sans","Noto Sans TC","sans-serif"]
}}}}
</script>
<title>David 素材展示</title>
<style>
:root{--primary:#5E6B7F;--secondary:#7B6B60;--bg-wash-1:#F0F2F5;--bg-wash-2:#E0E5EB;--on-surface:#1C1E22;--on-surface-variant:#44484F;--outline-variant:#C4C8D0}
body{background:radial-gradient(ellipse at top left,#F0F2F5 0%,#E0E5EB 50%,#E8E0F0 100%);min-height:100vh}
.watercolor-wash-header{mask-image:url("data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' preserveAspectRatio='none' xmlns='http://www.w3.org/2000/svg'><path d='M0,0 C20,10 40,-5 60,5 C80,15 100,0 100,0 L100,90 C80,100 60,85 40,95 C20,105 0,90 0,90 Z' fill='black'/></svg>");-webkit-mask-image:url("data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' preserveAspectRatio='none' xmlns='http://www.w3.org/2000/svg'><path d='M0,0 C20,10 40,-5 60,5 C80,15 100,0 100,0 L100,90 C80,100 60,85 40,95 C20,105 0,90 0,90 Z' fill='black'/></svg>");mask-size:100% 100%;-webkit-mask-size:100% 100%}
.card-hover{transition:transform .25s ease,box-shadow .25s ease}
.card-hover:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,.1)}
.nav-chip:hover{background:rgba(255,255,255,0.28) !important}
.material-symbols-outlined{font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24}
</style>
</head>
<body class="font-body" style="color:var(--on-surface)">

<header class="relative overflow-hidden">
  <div class="watercolor-wash-header px-6 py-12 md:py-16" style="background:linear-gradient(135deg,#5E6B7F 0%,#7B6B60 100%)">
    <div class="max-w-4xl mx-auto relative z-10">
      <div class="flex items-center gap-3 mb-3">
        <span class="material-symbols-outlined text-white/80" style="font-size:2rem">auto_stories</span>
        <div>
          <h1 class="font-headline text-3xl md:text-4xl text-white font-bold italic leading-tight">David 素材展示</h1>
          <p class="text-white/60 font-label text-sm tracking-[0.15em] uppercase mt-1">Teaching Materials Showcase</p>
        </div>
      </div>
      <p class="text-white/70 font-body text-base max-w-2xl leading-relaxed mt-4 mb-6">實驗中的華德福教學素材——持續增刪更新中</p>
      <nav class="flex flex-wrap gap-2">
        ${navItems}
      </nav>
    </div>
  </div>
  <div class="h-6 bg-gradient-to-b from-[#5E6B7F]/10 to-transparent"></div>
</header>

<main class="max-w-4xl mx-auto px-4 md:px-8 py-8">
  <div class="flex items-center justify-between mb-8">
    <p class="text-sm font-label" style="color:var(--on-surface-variant)">
      <span class="font-semibold">${totalFiles}</span> 件素材 &middot; <span class="font-semibold">${sections.length}</span> 個分類
    </p>
    <p class="text-xs font-label" style="color:var(--outline-variant)">Updated ${now}</p>
  </div>
${folderSections}
</main>

<footer style="background:var(--bg-wash-1)" class="border-t py-8 mt-4">
  <div class="max-w-4xl mx-auto flex flex-col items-center gap-2 px-6 text-center">
    <p class="font-headline italic text-lg" style="color:var(--primary)">宜蘭慈心華德福實驗學校</p>
    <p class="text-xs tracking-widest uppercase" style="color:var(--secondary)">Powered by TeacherOS</p>
  </div>
</footer>
</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('Connecting to Google Drive...');
  const drive = await getDriveClient();

  console.log('Listing subfolders...');
  const subfolders = await listSubfolders(drive, ROOT_FOLDER_ID);
  console.log(`Found ${subfolders.length} subfolders`);

  fs.mkdirSync(FILES_DIR, { recursive: true });

  const sections = [];

  for (const folder of subfolders) {
    const displayName = folderDisplayName(folder.name);
    const slug = safeFilename(folder.name);
    const folderDir = path.join(FILES_DIR, slug);
    fs.mkdirSync(folderDir, { recursive: true });

    console.log(`\n[${folder.name}]`);
    const files = await listHtmlFiles(drive, folder.id);
    console.log(`  ${files.length} files`);

    for (const file of files) {
      const localName = safeFilename(file.name);
      const destPath = path.join(folderDir, localName);
      const sizeMB = (parseInt(file.size || '0', 10) / 1024 / 1024).toFixed(1);
      console.log(`  ↓ ${file.name} (${sizeMB} MB)`);
      await downloadFile(drive, file.id, destPath);
    }

    if (files.length > 0) {
      sections.push({ displayName, slug, files });
    }
  }

  const html = generateIndex(sections);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), html);
  console.log(`\n✓ index.html generated (${sections.length} sections, ${sections.reduce((s,f)=>s+f.files.length,0)} files)`);
}

main().catch(err => {
  console.error('build-index failed:', err.message);
  process.exit(1);
});
