/**
 * build-index.js — Download HTML files from Google Drive and generate index page
 *
 * Produces:
 *   output/index.html          — Index page with card links
 *   output/files/{filename}    — Downloaded HTML files (served directly)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const FOLDER_ID = '1rK3Eq8LH2Sg9YRBUcPA6PzQhDzVckLCq';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const FILES_DIR = path.join(OUTPUT_DIR, 'files');

// ─── Drive Auth ──────────────────────────────────────────────
async function getDriveClient() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } else {
    const keyPath = path.join(__dirname, '..', 'service-account-key.json');
    if (fs.existsSync(keyPath)) {
      credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } else {
      console.error('No service account key found. Set GOOGLE_SERVICE_ACCOUNT_KEY env var.');
      process.exit(1);
    }
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// ─── List HTML files ─────────────────────────────────────────
async function listHtmlFiles(drive) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and mimeType='text/html' and trashed=false`,
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

// ─── Download file ───────────────────────────────────────────
async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  fs.writeFileSync(destPath, Buffer.from(res.data));
}

// ─── Parse display name from filename ────────────────────────
function parseDisplayName(filename) {
  let name = filename.replace(/\.html$/i, '');
  name = name.replace(/[-_]*(v\d+(\.\d+)?|完整版|美化版|full|校準版|拷貝)[-_]*/gi, '');
  name = name.replace(/[-_]+/g, ' ').trim();
  return name || filename;
}

// ─── Format date ─────────────────────────────────────────────
function formatDate(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Escape HTML ─────────────────────────────────────────────
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Safe filename (URL-friendly) ────────────────────────────
function safeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-');
}

// ─── Generate HTML ───────────────────────────────────────────
function generateIndex(files) {
  const sorted = [...files].sort((a, b) =>
    new Date(b.modifiedTime) - new Date(a.modifiedTime)
  );

  const cards = sorted.map(file => {
    const displayName = parseDisplayName(file.name);
    const date = formatDate(file.modifiedTime);
    const sizeKB = Math.round(parseInt(file.size || '0', 10) / 1024);
    const localFile = safeFilename(file.name);
    const href = `files/${encodeURIComponent(localFile)}`;

    return `
    <a href="${href}" class="card-hover block rounded-xl overflow-hidden bg-white shadow-sm">
      <div class="p-5">
        <div class="flex items-start gap-3">
          <span class="material-symbols-outlined mt-0.5 shrink-0" style="color:var(--primary);font-size:1.3rem">description</span>
          <div class="min-w-0">
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

  const now = new Date().toISOString().split('T')[0];

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Plus+Jakarta+Sans:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script>
tailwind.config={theme:{extend:{fontFamily:{"headline":["Playfair Display","Noto Serif TC","Georgia","serif"],"body":["Plus Jakarta Sans","Noto Sans TC","PingFang TC","Microsoft JhengHei","sans-serif"],"label":["Plus Jakarta Sans","Noto Sans TC","sans-serif"]}}}}
</script>
<title>David 素材展示</title>
<style>
:root{--primary:#5E6B7F;--secondary:#7B6B60;--accent:#8B7B9B;--bg-wash-1:#F0F2F5;--bg-wash-2:#E0E5EB;--on-surface:#1C1E22;--on-surface-variant:#44484F;--outline-variant:#C4C8D0}
body{background:radial-gradient(ellipse at top left,#F0F2F5 0%,#E0E5EB 50%,#E8E0F0 100%);min-height:100vh}
.watercolor-wash-header{mask-image:url("data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' preserveAspectRatio='none' xmlns='http://www.w3.org/2000/svg'><path d='M0,0 C20,10 40,-5 60,5 C80,15 100,0 100,0 L100,90 C80,100 60,85 40,95 C20,105 0,90 0,90 Z' fill='black'/></svg>");-webkit-mask-image:url("data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' preserveAspectRatio='none' xmlns='http://www.w3.org/2000/svg'><path d='M0,0 C20,10 40,-5 60,5 C80,15 100,0 100,0 L100,90 C80,100 60,85 40,95 C20,105 0,90 0,90 Z' fill='black'/></svg>");mask-size:100% 100%;-webkit-mask-size:100% 100%}
.card-hover{transition:transform .25s ease,box-shadow .25s ease}
.card-hover:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,.1)}
.material-symbols-outlined{font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24}
</style>
</head>
<body class="font-body" style="color:var(--on-surface)">
<header class="relative overflow-hidden">
  <div class="watercolor-wash-header px-6 py-12 md:py-16" style="background:linear-gradient(135deg,#5E6B7F 0%,#7B6B60 100%)">
    <div class="max-w-4xl mx-auto relative z-10">
      <div class="flex items-center gap-3 mb-3">
        <span class="material-symbols-outlined text-white/80" style="font-size:2rem">science</span>
        <div>
          <h1 class="font-headline text-3xl md:text-4xl text-white font-bold italic leading-tight">David 素材展示</h1>
          <p class="text-white/60 font-label text-sm tracking-[0.15em] uppercase mt-1">Teaching Materials Showcase</p>
        </div>
      </div>
      <p class="text-white/70 font-body text-base max-w-2xl leading-relaxed mt-4">實驗中的華德福教學素材——持續增刪更新中</p>
    </div>
  </div>
  <div class="h-6 bg-gradient-to-b from-[#5E6B7F]/10 to-transparent"></div>
</header>
<main class="max-w-4xl mx-auto px-4 md:px-8 py-8">
  <div class="flex items-center justify-between mb-6">
    <p class="text-sm font-label" style="color:var(--on-surface-variant)"><span class="font-semibold">${files.length}</span> files &middot; newest first</p>
    <p class="text-xs font-label" style="color:var(--outline-variant)">Updated ${now}</p>
  </div>
  <div class="grid grid-cols-1 gap-3">
${cards}
  </div>
</main>
<footer style="background:var(--bg-wash-1)" class="border-t py-8 mt-8">
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

  console.log(`Listing HTML files in folder ${FOLDER_ID}...`);
  const files = await listHtmlFiles(drive);
  console.log(`Found ${files.length} files`);

  fs.mkdirSync(FILES_DIR, { recursive: true });

  // Download all HTML files
  for (const file of files) {
    const localName = safeFilename(file.name);
    const destPath = path.join(FILES_DIR, localName);
    const sizeMB = (parseInt(file.size || '0', 10) / 1024 / 1024).toFixed(1);
    console.log(`  Downloading: ${file.name} (${sizeMB} MB)...`);
    await downloadFile(drive, file.id, destPath);
  }

  // Generate index
  const html = generateIndex(files);
  const outPath = path.join(OUTPUT_DIR, 'index.html');
  fs.writeFileSync(outPath, html);
  console.log(`\nGenerated: index.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  console.log(`Total: ${files.length} files downloaded to output/files/`);
}

main().catch(err => {
  console.error('build-index failed:', err.message);
  process.exit(1);
});
