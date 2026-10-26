const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const LINKS_FILE = path.join(ROOT, 'hans-links.md');
const IMPORTS_FILE = path.join(ROOT, 'imported-history.json');
const REPOSITORY = 'hansschenker/hans-links';
const REMOTE_LINKS_PATH = 'hans-links.md';
const REMOTE_IMPORTS_PATH = 'imported-history.json';
const HISTORY_FILE_PATTERN = /^history[-_]\d{4}-\d{2}-\d{2}\.html$/i;

function decodeHistoryPayload(html) {
  const match = html.match(/safeDecode\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/);
  if (!match) {
    throw new Error('No encoded history data was found');
  }

  const percentEncodedJson = Buffer.from(match[1], 'base64').toString('utf8');
  return JSON.parse(decodeURIComponent(percentEncodedJson));
}

function cleanTitle(value, url) {
  const title = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (title) return title;
  return url || 'Untitled link';
}

function normalizeLink(item) {
  if (!item || typeof item.url !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(item.url.trim());
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  return {
    title: cleanTitle(item.title, parsed.href),
    url: parsed.href,
  };
}

function extractLinks(html) {
  const data = decodeHistoryPayload(html);
  if (!Array.isArray(data)) {
    throw new Error('History data is not an array');
  }

  return data.map(normalizeLink).filter(Boolean);
}

function extractUrls(text) {
  const urls = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const angleMarkdownMatch = line.match(/\]\(<(https?:\/\/[^>]+)>\)/i);
    if (angleMarkdownMatch) {
      urls.add(angleMarkdownMatch[1]);
      continue;
    }

    const markdownMatch = line.match(/\]\((https?:\/\/.+)\)\s*$/i);
    if (markdownMatch) {
      urls.add(markdownMatch[1]);
      continue;
    }

    const legacyMatch = line.match(/https?:\/\/\S+\s*$/i);
    if (legacyMatch) urls.add(legacyMatch[0].trim());
  }
  return urls;
}

function escapeMarkdownLabel(value) {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

function serializeLink({ title, url }) {
  return `[${escapeMarkdownLabel(cleanTitle(title, url))}](${url})`;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function readText(filePath, fallback = '') {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readJson(filePath, fallback) {
  const text = await readText(filePath);
  if (!text.trim()) return fallback;

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      const error = new Error(stderr.trim() || `GitHub CLI exited with code ${code}`);
      error.exitCode = code;
      reject(error);
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function getRemoteFile(filePath) {
  try {
    const output = await runGh(['api', `repos/${REPOSITORY}/contents/${filePath}`]);
    const result = JSON.parse(output);
    return {
      content: Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8'),
      sha: result.sha,
    };
  } catch (error) {
    if (/HTTP 404|Not Found/i.test(error.message)) return null;
    throw error;
  }
}

async function putRemoteFile(filePath, content, message) {
  const current = await getRemoteFile(filePath);
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
  };
  if (current?.sha) body.sha = current.sha;

  await runGh(
    ['api', '--method', 'PUT', `repos/${REPOSITORY}/contents/${filePath}`, '--input', '-'],
    JSON.stringify(body),
  );
}

async function getCanonicalLinksText() {
  const remote = await getRemoteFile(REMOTE_LINKS_PATH);
  if (remote) return remote.content;
  return readText(LINKS_FILE);
}

async function getImportLedger() {
  const local = await readJson(IMPORTS_FILE, []);
  const remote = await getRemoteFile(REMOTE_IMPORTS_PATH);
  let remoteItems = [];

  if (remote) {
    try {
      remoteItems = JSON.parse(remote.content);
    } catch {
      remoteItems = [];
    }
  }

  const byHash = new Map();
  for (const item of [...local, ...(Array.isArray(remoteItems) ? remoteItems : [])]) {
    if (item && item.sha256) byHash.set(item.sha256, item);
  }
  return [...byHash.values()];
}

async function scanHistory() {
  const [directoryEntries, ledger, linksText] = await Promise.all([
    fs.readdir(ROOT, { withFileTypes: true }),
    getImportLedger(),
    getCanonicalLinksText(),
  ]);
  const importedHashes = new Set(ledger.map((item) => item.sha256));
  const existingUrls = extractUrls(linksText);
  const seenUrls = new Set(existingUrls);
  const files = [];
  const links = [];
  let duplicateCount = 0;

  const candidates = directoryEntries
    .filter((entry) => entry.isFile() && HISTORY_FILE_PATTERN.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of candidates) {
    const html = await fs.readFile(path.join(ROOT, entry.name), 'utf8');
    const sha256 = hashContent(html);
    if (importedHashes.has(sha256)) continue;

    const extracted = extractLinks(html);
    let newCount = 0;
    for (const link of extracted) {
      if (seenUrls.has(link.url)) {
        duplicateCount += 1;
        continue;
      }
      seenUrls.add(link.url);
      links.push({
        id: `${sha256.slice(0, 12)}-${links.length}`,
        sourceFile: entry.name,
        ...link,
      });
      newCount += 1;
    }

    files.push({ name: entry.name, sha256, extracted: extracted.length, newCount });
  }

  return {
    repository: REPOSITORY,
    files,
    links,
    duplicateCount,
    existingCount: existingUrls.size,
  };
}

async function parseRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function saveSelection(payload) {
  const submittedLinks = Array.isArray(payload.links) ? payload.links : [];
  const submittedFiles = Array.isArray(payload.files) ? payload.files : [];
  const currentLinks = await getCanonicalLinksText();
  const knownUrls = extractUrls(currentLinks);
  const accepted = [];

  for (const item of submittedLinks) {
    const link = normalizeLink(item);
    if (!link || knownUrls.has(link.url)) continue;
    knownUrls.add(link.url);
    accepted.push(link);
  }

  const prefix = currentLinks.trimEnd();
  const appended = accepted.map(serializeLink).join('\n');
  const nextLinks = [prefix, appended].filter(Boolean).join('\n') + '\n';
  const now = new Date().toISOString();
  const ledger = await getImportLedger();
  const ledgerByHash = new Map(ledger.map((item) => [item.sha256, item]));

  for (const file of submittedFiles) {
    if (!file || !HISTORY_FILE_PATTERN.test(String(file.name)) || !/^[a-f0-9]{64}$/.test(String(file.sha256))) {
      continue;
    }
    ledgerByHash.set(file.sha256, {
      fileName: file.name,
      sha256: file.sha256,
      importedAt: now,
      savedLinks: accepted.filter((link) => submittedLinks.some((item) => item.url === link.url && item.sourceFile === file.name)).length,
    });
  }

  const nextLedger = [...ledgerByHash.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const ledgerText = `${JSON.stringify(nextLedger, null, 2)}\n`;
  const date = now.slice(0, 10);

  if (accepted.length > 0 || !currentLinks.trim()) {
    await putRemoteFile(REMOTE_LINKS_PATH, nextLinks, `Add ${accepted.length} links from Chrome history (${date})`);
  }
  await putRemoteFile(REMOTE_IMPORTS_PATH, ledgerText, `Record imported Chrome history (${date})`);
  await Promise.all([
    fs.writeFile(LINKS_FILE, nextLinks, 'utf8'),
    fs.writeFile(IMPORTS_FILE, ledgerText, 'utf8'),
  ]);

  return { savedCount: accepted.length, repository: REPOSITORY };
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extension] || 'application/octet-stream';
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  if (!resolved.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
    return sendJson(response, 404, { error: 'Not found' });
  }

  try {
    const data = await fs.readFile(resolved);
    response.writeHead(200, { 'Content-Type': contentType(resolved), 'Cache-Control': 'no-store' });
    response.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(response, 404, { error: 'Not found' });
    throw error;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/api/history') {
        return sendJson(response, 200, await scanHistory());
      }
      if (request.method === 'POST' && url.pathname === '/api/save') {
        return sendJson(response, 200, await saveSelection(await parseRequestBody(request)));
      }
      if (request.method === 'GET') return serveStatic(response, url.pathname);
      return sendJson(response, 405, { error: 'Method not allowed' });
    } catch (error) {
      console.error(error);
      return sendJson(response, 500, { error: error.message || 'Unexpected server error' });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`Hans Links is ready at http://127.0.0.1:${PORT}`);
  });
}

module.exports = {
  HISTORY_FILE_PATTERN,
  cleanTitle,
  decodeHistoryPayload,
  extractLinks,
  extractUrls,
  hashContent,
  normalizeLink,
  serializeLink,
};
