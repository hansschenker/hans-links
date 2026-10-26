const state = {
  files: [],
  links: [],
  query: '',
  saving: false,
};

const elements = {
  body: document.querySelector('#links-body'),
  deleteVisible: document.querySelector('#delete-visible-button'),
  emptyState: document.querySelector('#empty-state'),
  existingCount: document.querySelector('#existing-count'),
  fileCount: document.querySelector('#file-count'),
  fileNote: document.querySelector('#file-note'),
  linkCount: document.querySelector('#link-count'),
  refresh: document.querySelector('#refresh-button'),
  save: document.querySelector('#save-button'),
  saveCount: document.querySelector('#save-count'),
  saveDetail: document.querySelector('#save-detail'),
  search: document.querySelector('#search-input'),
  status: document.querySelector('#status'),
  tableWrap: document.querySelector('#table-wrap'),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function visibleLinks() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.links;
  return state.links.filter((link) =>
    [link.title, link.url, link.sourceFile].some((value) => value.toLowerCase().includes(query)),
  );
}

function markdownLink(link) {
  const title = link.title.trim();
  if (!title) return 'Title required';
  const label = title.replace(/([\\\[\]])/g, '\\$1');
  return `[${label}](${link.url})`;
}

function updateSaveSummary() {
  const count = state.links.length;
  const missingTitleCount = state.links.filter((link) => !link.title.trim()).length;
  elements.saveCount.textContent = `${count} ${count === 1 ? 'link' : 'links'} ready`;
  elements.saveDetail.textContent = missingTitleCount
    ? `Add a Markdown title to ${missingTitleCount} ${missingTitleCount === 1 ? 'link' : 'links'} before saving.`
    : state.files.length
    ? `${state.files.length} ${state.files.length === 1 ? 'history file' : 'history files'} will be marked as imported.`
    : 'Nothing has been changed on GitHub.';
  elements.save.disabled = state.saving || state.files.length === 0 || missingTitleCount > 0;
}

function render() {
  const visible = visibleLinks();
  elements.body.innerHTML = visible.map((link) => `
    <tr data-id="${escapeHtml(link.id)}">
      <td data-label="Markdown title">
        <div class="title-field">
          <input class="cell-input title-input" value="${escapeHtml(link.title)}" placeholder="Enter a title for this link" aria-label="Markdown title for ${escapeHtml(link.url)}" aria-invalid="${!link.title.trim()}" required>
          <code class="markdown-preview">${escapeHtml(markdownLink(link))}</code>
        </div>
      </td>
      <td data-label="URL">
        <input class="cell-input url-input" value="${escapeHtml(link.url)}" aria-label="Link URL" type="url">
      </td>
      <td class="source-column source-cell" data-label="Source">${escapeHtml(link.sourceFile)}</td>
      <td class="delete-cell">
        <button class="delete-button" type="button" aria-label="Delete ${escapeHtml(link.title)}" title="Delete link">×</button>
      </td>
    </tr>
  `).join('');

  const hasFiles = state.files.length > 0;
  const hasVisible = visible.length > 0;
  elements.tableWrap.hidden = !hasVisible;
  elements.emptyState.hidden = hasFiles || hasVisible;
  elements.status.hidden = hasVisible || !hasFiles;
  elements.status.textContent = hasFiles && !hasVisible
    ? state.links.length ? 'No links match your search.' : 'All links were removed. Save to mark these files as imported.'
    : '';
  elements.deleteVisible.disabled = !hasVisible;
  updateSaveSummary();
}

function updateLink(id, field, value) {
  const link = state.links.find((item) => item.id === id);
  if (link) link[field] = value;
}

function deleteLink(id) {
  state.links = state.links.filter((item) => item.id !== id);
  render();
}

async function loadHistory() {
  elements.refresh.disabled = true;
  elements.status.hidden = false;
  elements.status.textContent = 'Reading history files…';
  elements.tableWrap.hidden = true;
  elements.emptyState.hidden = true;

  try {
    const response = await fetch('/api/history', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not read history files');

    state.files = data.files;
    state.links = data.links;
    elements.fileCount.textContent = data.files.length.toLocaleString();
    elements.linkCount.textContent = data.links.length.toLocaleString();
    elements.existingCount.textContent = data.existingCount.toLocaleString();

    if (data.files.length) {
      const names = data.files.map((file) => `${file.name} (${file.newCount} new)`).join(' · ');
      const duplicates = data.duplicateCount
        ? ` ${data.duplicateCount.toLocaleString()} duplicate ${data.duplicateCount === 1 ? 'visit was' : 'visits were'} omitted.`
        : '';
      elements.fileNote.textContent = `${names}.${duplicates}`;
    } else {
      elements.fileNote.textContent = 'All matching history files in this folder have already been imported.';
    }
    render();
  } catch (error) {
    state.files = [];
    state.links = [];
    elements.status.hidden = false;
    elements.status.textContent = error.message;
    elements.fileNote.textContent = '';
    updateSaveSummary();
  } finally {
    elements.refresh.disabled = false;
  }
}

async function saveLinks() {
  const missingTitle = state.links.find((link) => !link.title.trim());
  if (missingTitle) {
    document.querySelector(`tr[data-id="${CSS.escape(missingTitle.id)}"] .title-input`)?.focus();
    updateSaveSummary();
    return;
  }

  state.saving = true;
  elements.save.textContent = 'Saving…';
  elements.saveDetail.textContent = 'Committing your list and import ledger.';
  updateSaveSummary();

  try {
    const response = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: state.links, files: state.files }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save to GitHub');

    elements.saveDetail.textContent = `${data.savedCount} ${data.savedCount === 1 ? 'link was' : 'links were'} committed to ${data.repository}.`;
    state.files = [];
    state.links = [];
    await loadHistory();
  } catch (error) {
    elements.saveDetail.textContent = error.message;
  } finally {
    state.saving = false;
    elements.save.textContent = 'Save to GitHub';
    updateSaveSummary();
  }
}

elements.body.addEventListener('input', (event) => {
  const row = event.target.closest('tr');
  if (!row) return;
  if (event.target.classList.contains('title-input')) {
    updateLink(row.dataset.id, 'title', event.target.value);
    event.target.setAttribute('aria-invalid', String(!event.target.value.trim()));
  }
  if (event.target.classList.contains('url-input')) updateLink(row.dataset.id, 'url', event.target.value);

  const link = state.links.find((item) => item.id === row.dataset.id);
  if (link) row.querySelector('.markdown-preview').textContent = markdownLink(link);
  updateSaveSummary();
});

elements.body.addEventListener('click', (event) => {
  const button = event.target.closest('.delete-button');
  if (button) deleteLink(button.closest('tr').dataset.id);
});

elements.search.addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});

elements.deleteVisible.addEventListener('click', () => {
  const visibleIds = new Set(visibleLinks().map((link) => link.id));
  state.links = state.links.filter((link) => !visibleIds.has(link.id));
  render();
});

elements.refresh.addEventListener('click', loadHistory);
elements.save.addEventListener('click', saveLinks);

loadHistory();
