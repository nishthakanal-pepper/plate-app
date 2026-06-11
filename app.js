// ===== State =====
let state = {
  workspaces: [],
  tasks: [],
  templates: [],
  settings: { theme: 'dark' }
};
let currentView = 'today';
let currentWorkspaceId = null;
let editingTaskId = null;
let editingTemplateId = null;
let spawnTemplateId = null;
let ghToken = null;
let ghUsername = null;
let fileSha = null;
let showArchived = false;
let dragTaskId = null;

// ===== Constants =====
const REPO = 'plate-data';
const FILE = 'plate-data.json';
const PALETTE = ['#60a5fa','#f472b6','#34d399','#fbbf24','#a78bfa','#fb923c','#f87171','#4ade80','#38bdf8','#e879f9','#2dd4bf','#facc15'];
const DEFAULT_WORKSPACES = [
  { name: 'Sovos', color: '#60a5fa' },
  { name: 'Murf AI', color: '#f472b6' },
  { name: 'Payoneer', color: '#34d399' },
  { name: 'Kuehne+Nagel', color: '#fbbf24' },
  { name: 'Wizeline', color: '#a78bfa' },
  { name: 'PwC India', color: '#fb923c' },
  { name: 'Inbox', color: '#6b7280' },
];

// ===== Helpers =====
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function calculateNextOccurrence(fromDate, repeat) {
  const d = new Date(fromDate + 'T00:00:00');
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function spawnNextOccurrence(task) {
  const nextDue = task.repeatNext;
  if (!nextDue || !task.repeat) return;
  // Advance repeatNext until it's in the future
  let newRepeatNext = nextDue;
  const t = today();
  do { newRepeatNext = calculateNextOccurrence(newRepeatNext, task.repeat); } while (newRepeatNext <= t);

  state.tasks.push({
    id: uuid(),
    title: task.title,
    workspaceId: task.workspaceId,
    status: 'Not Started',
    priority: task.priority,
    dueDate: nextDue,
    contentType: task.contentType,
    notes: '',
    subtasks: (task.subtasks || []).map(s => ({ id: uuid(), title: s.title, done: false })),
    createdAt: new Date().toISOString(),
    completedAt: null,
    repeat: task.repeat,
    repeatNext: newRepeatNext,
  });
  // Original task loses its repeat — it becomes a plain completed/overdue task
  task.repeat = null;
  task.repeatNext = null;
}

async function checkAndSpawnRecurring() {
  const t = today();
  let changed = false;
  state.tasks.forEach(task => {
    if (!task.repeat || !task.repeatNext) return;
    if (task.repeatNext <= t) {
      spawnNextOccurrence(task);
      changed = true;
    }
  });
  if (changed) await saveData();
}

function isoToDisplay(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function getDeadlineStatus(dueDate, status) {
  if (!dueDate || status === 'Done') return null;
  const t = today();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  if (dueDate < t) return 'overdue';
  if (dueDate === t) return 'due-today';
  if (dueDate === tomorrowStr) return 'due-soon';
  return null;
}

function getWorkspace(id) {
  return state.workspaces.find(w => w.id === id);
}

function showSaveIndicator() {
  const el = document.getElementById('save-indicator');
  el.classList.remove('hidden');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.add('hidden'), 1800);
}

// ===== GitHub API =====
async function ghFetch(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${ghToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res;
}

async function ensureRepo() {
  const res = await ghFetch(`/repos/${ghUsername}/${REPO}`);
  if (res.status === 404) {
    await ghFetch(`/user/repos`, {
      method: 'POST',
      body: JSON.stringify({ name: REPO, private: true, description: 'Plate task manager data' }),
    });
  }
}

async function loadData() {
  const res = await ghFetch(`/repos/${ghUsername}/${REPO}/contents/${FILE}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to load data');
  const json = await res.json();
  fileSha = json.sha;
  const content = atob(json.content.replace(/\n/g, ''));
  return JSON.parse(content);
}

async function saveData() {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(state, null, 2))));
  const body = { message: 'Update plate-data', content, sha: fileSha };
  const res = await ghFetch(`/repos/${ghUsername}/${REPO}/contents/${FILE}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Save failed');
  const json = await res.json();
  fileSha = json.content.sha;
  showSaveIndicator();
}

// ===== Init =====
async function init() {
  ghToken = localStorage.getItem('gh_token');
  ghUsername = localStorage.getItem('gh_username');

  if (!ghToken || !ghUsername) {
    document.getElementById('setup-screen').classList.remove('hidden');
    return;
  }

  document.getElementById('app').classList.remove('hidden');
  await loadAndRender();
}

async function loadAndRender() {
  try {
    await ensureRepo();
    const data = await loadData();
    if (data) {
      state = data;
      // Ensure required arrays exist
      if (!state.workspaces) state.workspaces = [];
      if (!state.tasks) state.tasks = [];
      if (!state.templates) state.templates = [];
      if (!state.settings) state.settings = { theme: 'dark' };
    } else {
      // First run: seed defaults
      state.workspaces = DEFAULT_WORKSPACES.map((w, i) => ({
        id: uuid(), name: w.name, color: w.color, archived: false, order: i, createdAt: new Date().toISOString()
      }));
      state.templates = [{
        id: uuid(),
        name: 'Article Workflow',
        subtasks: ['Brief', 'Outline', 'Draft', 'Edit', 'Client Review', 'Publish']
      }];
      await saveData();
    }
  } catch (e) {
    console.error(e);
    alert('Failed to connect to GitHub. Check your token and username.');
    return;
  }

  await checkAndSpawnRecurring();
  renderSidebar();
  renderWorkspaceDropdowns();
  navigateTo('today');
  document.getElementById('settings-username').textContent = ghUsername;
}

// ===== Setup form =====
document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('gh-username').value.trim();
  const token = document.getElementById('gh-token').value.trim();
  const errEl = document.getElementById('setup-error');
  errEl.classList.add('hidden');

  if (!username || !token) return;

  // Test token
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}` }
    });
    if (!res.ok) throw new Error('Invalid token');
    const user = await res.json();
    if (user.login.toLowerCase() !== username.toLowerCase()) {
      throw new Error('Username does not match token owner');
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    return;
  }

  localStorage.setItem('gh_token', token);
  localStorage.setItem('gh_username', username);
  ghToken = token;
  ghUsername = username;

  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  await loadAndRender();
});

// ===== Navigation =====
function navigateTo(view, workspaceId = null) {
  currentView = view;
  currentWorkspaceId = workspaceId;

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.workspace-item').forEach(w => w.classList.remove('active'));

  const titleEl = document.getElementById('view-title');
  const addBtn = document.getElementById('topbar-add-btn');

  if (view === 'workspace' && workspaceId) {
    document.getElementById('view-workspace').classList.add('active');
    const ws = getWorkspace(workspaceId);
    titleEl.textContent = ws ? ws.name : 'Workspace';
    document.querySelector(`.workspace-item[data-id="${workspaceId}"]`)?.classList.add('active');
    addBtn.classList.remove('hidden');
    renderKanban(workspaceId);
  } else {
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    const navItem = document.querySelector(`.nav-item[data-view="${view}"], .bottom-nav-item[data-view="${view}"]`);
    if (navItem) navItem.classList.add('active');

    if (view === 'today') {
      titleEl.textContent = 'Today';
      addBtn.classList.remove('hidden');
      renderToday();
    } else if (view === 'all-tasks') {
      titleEl.textContent = 'All Tasks';
      addBtn.classList.remove('hidden');
      renderAllTasks();
    } else if (view === 'weekly') {
      titleEl.textContent = 'Weekly';
      addBtn.classList.remove('hidden');
      renderWeekly();
    } else if (view === 'settings') {
      titleEl.textContent = 'Settings';
      addBtn.classList.add('hidden');
      renderSettings();
    }
  }
}

// ===== Sidebar =====
function renderSidebar() {
  const list = document.getElementById('workspace-list');
  list.innerHTML = '';
  const workspaces = state.workspaces
    .filter(w => showArchived || !w.archived)
    .sort((a, b) => a.order - b.order);

  workspaces.forEach(ws => {
    const li = document.createElement('li');
    li.className = 'workspace-item' + (currentWorkspaceId === ws.id ? ' active' : '');
    li.dataset.id = ws.id;
    li.draggable = true;
    li.innerHTML = `
      <span class="ws-drag-handle" title="Drag to reorder">⠿</span>
      <span class="ws-dot" style="background:${ws.color}"></span>
      <span class="ws-name">${escHtml(ws.name)}</span>
      <span class="ws-actions">
        <button class="ws-action-btn" data-action="edit" title="Rename">✏️</button>
        <button class="ws-action-btn" data-action="archive" title="${ws.archived ? 'Unarchive' : 'Archive'}">📦</button>
        <button class="ws-action-btn" data-action="delete" title="Delete">🗑</button>
      </span>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.ws-action-btn')) return;
      navigateTo('workspace', ws.id);
    });
    li.querySelectorAll('.ws-action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleWsAction(ws.id, btn.dataset.action);
      });
    });

    // Drag-and-drop reordering
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', ws.id);
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drag-over-ws');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over-ws'));
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('drag-over-ws');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId === ws.id) return;
      const dragged = state.workspaces.find(w => w.id === draggedId);
      const target = state.workspaces.find(w => w.id === ws.id);
      if (!dragged || !target) return;
      // Swap orders
      const tmp = dragged.order;
      dragged.order = target.order;
      target.order = tmp;
      // Re-normalize orders
      state.workspaces
        .filter(w => showArchived || !w.archived)
        .sort((a, b) => a.order - b.order)
        .forEach((w, i) => { w.order = i; });
      await saveData();
      renderSidebar();
    });

    list.appendChild(li);
  });

  renderWorkspaceDropdowns();
}

function renderWorkspaceDropdowns() {
  const workspaces = state.workspaces.filter(w => !w.archived).sort((a, b) => a.order - b.order);
  ['task-workspace', 'qa-workspace', 'spawn-workspace', 'filter-workspace'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const isFilter = id === 'filter-workspace';
    const prevVal = sel.value;
    sel.innerHTML = isFilter ? '<option value="">All Workspaces</option>' : '';
    workspaces.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.id;
      opt.textContent = ws.name;
      sel.appendChild(opt);
    });
    if (prevVal) sel.value = prevVal;
  });
}

// ===== Workspace actions =====
async function handleWsAction(wsId, action) {
  const ws = getWorkspace(wsId);
  if (!ws) return;

  if (action === 'edit') {
    openWsModal(wsId);
  } else if (action === 'archive') {
    ws.archived = !ws.archived;
    await saveData();
    renderSidebar();
    if (currentWorkspaceId === wsId && ws.archived) navigateTo('today');
  } else if (action === 'delete') {
    const taskCount = state.tasks.filter(t => t.workspaceId === wsId).length;
    if (taskCount > 0) {
      if (confirm(`This workspace has ${taskCount} task(s). Archive it instead?`)) {
        ws.archived = true;
        await saveData();
        renderSidebar();
        if (currentWorkspaceId === wsId) navigateTo('today');
      }
    } else {
      if (confirm(`Delete workspace "${ws.name}"?`)) {
        state.workspaces = state.workspaces.filter(w => w.id !== wsId);
        await saveData();
        renderSidebar();
        if (currentWorkspaceId === wsId) navigateTo('today');
      }
    }
  }
}

// ===== Workspace modal =====
let selectedColor = '#7c6af7';
let editingWsId = null;

function openWsModal(wsId = null) {
  editingWsId = wsId;
  const ws = wsId ? getWorkspace(wsId) : null;
  document.getElementById('ws-modal-title').textContent = wsId ? 'Edit Workspace' : 'Add Workspace';
  document.getElementById('ws-name').value = ws ? ws.name : '';
  selectedColor = ws ? ws.color : '#7c6af7';
  document.getElementById('ws-color-hex').value = selectedColor;
  renderColorPalette();
  showModal('ws-modal');
}

function renderColorPalette() {
  const palette = document.getElementById('color-palette');
  palette.innerHTML = '';
  PALETTE.forEach(color => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch' + (color === selectedColor ? ' selected' : '');
    swatch.style.background = color;
    swatch.addEventListener('click', () => {
      selectedColor = color;
      document.getElementById('ws-color-hex').value = color;
      renderColorPalette();
    });
    palette.appendChild(swatch);
  });
}

document.getElementById('ws-color-hex').addEventListener('input', (e) => {
  const val = e.target.value;
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    selectedColor = val;
    renderColorPalette();
  }
});

document.getElementById('save-ws-btn').addEventListener('click', async () => {
  const name = document.getElementById('ws-name').value.trim();
  if (!name) return;
  if (editingWsId) {
    const ws = getWorkspace(editingWsId);
    ws.name = name;
    ws.color = selectedColor;
  } else {
    const maxOrder = state.workspaces.reduce((m, w) => Math.max(m, w.order), -1);
    state.workspaces.push({ id: uuid(), name, color: selectedColor, archived: false, order: maxOrder + 1, createdAt: new Date().toISOString() });
  }
  await saveData();
  renderSidebar();
  if (currentView === 'workspace') renderKanban(currentWorkspaceId);
  closeModal('ws-modal');
});

document.getElementById('add-workspace-btn').addEventListener('click', () => openWsModal());
document.getElementById('cancel-ws-modal').addEventListener('click', () => closeModal('ws-modal'));
document.getElementById('close-ws-modal').addEventListener('click', () => closeModal('ws-modal'));

// ===== Today view =====
function renderToday() {
  const t = today();
  const todayEl = document.getElementById('today-content');
  const emptyEl = document.getElementById('today-empty');
  todayEl.innerHTML = '';

  const dueTasks = state.tasks.filter(task => {
    if (!task.dueDate) return false;
    if (task.status === 'Done') return false;
    return task.dueDate <= t;
  });

  if (dueTasks.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const byWorkspace = {};
  dueTasks.forEach(task => {
    if (!byWorkspace[task.workspaceId]) byWorkspace[task.workspaceId] = [];
    byWorkspace[task.workspaceId].push(task);
  });

  Object.entries(byWorkspace).forEach(([wsId, tasks]) => {
    const ws = getWorkspace(wsId);
    const group = document.createElement('div');
    group.className = 'today-workspace-group';
    group.innerHTML = `
      <div class="today-ws-header">
        <span class="ws-dot" style="background:${ws?.color || '#6b7280'}"></span>
        ${escHtml(ws?.name || 'Unknown')}
      </div>
    `;
    tasks.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).forEach(task => {
      group.appendChild(buildTaskCard(task));
    });
    todayEl.appendChild(group);
  });
}

function buildTaskCard(task) {
  const status = getDeadlineStatus(task.dueDate, task.status);
  const isDone = task.status === 'Done';
  const card = document.createElement('div');
  card.className = `task-card${status ? ' ' + status : ''}${isDone ? ' done' : ''}`;
  card.dataset.id = task.id;

  const donePct = task.subtasks?.length
    ? `${task.subtasks.filter(s => s.done).length}/${task.subtasks.length}`
    : '';

  let dueHtml = '';
  if (task.dueDate && !isDone) {
    const label = task.dueDate < today() ? 'Overdue' : isoToDisplay(task.dueDate);
    const cls = status === 'overdue' ? 'overdue' : status === 'due-today' ? 'due-today' : '';
    dueHtml = `<span class="due-label ${cls}">${label}</span>`;
  }

  const priorityHtml = task.priority ? `<span class="priority-badge ${task.priority.toLowerCase()}">${task.priority}</span>` : '';
  const typeHtml = task.contentType ? `<span class="content-type-tag">${task.contentType}</span>` : '';
  const subtaskHtml = donePct ? `<span class="subtask-count">☑ ${donePct}</span>` : '';

  card.innerHTML = `
    <div class="task-card-top">
      <button class="task-check${isDone ? ' checked' : ''}" title="${isDone ? 'Mark incomplete' : 'Mark done'}"></button>
      <div class="task-card-title">${escHtml(task.title)}</div>
    </div>
    <div class="task-card-meta">
      ${dueHtml}${priorityHtml}${typeHtml}${subtaskHtml}
    </div>
  `;

  card.querySelector('.task-check').addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleTaskDone(task.id);
  });
  card.addEventListener('click', () => openTaskPanel(task.id));
  return card;
}

// ===== Kanban view =====
function renderKanban(wsId) {
  const ws = getWorkspace(wsId);
  let header = document.querySelector('.workspace-kanban-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'workspace-kanban-header';
    document.getElementById('view-workspace').prepend(header);
  }
  header.innerHTML = `
    <div class="workspace-kanban-title">
      <span class="ws-dot" style="background:${ws?.color};width:12px;height:12px"></span>
      ${escHtml(ws?.name || '')}
    </div>
  `;

  const statuses = ['Not Started', 'In Progress', 'With Client', 'Done'];
  statuses.forEach(status => {
    const col = document.querySelector(`.kanban-cards[data-status="${status}"]`);
    const tasks = state.tasks.filter(t => t.workspaceId === wsId && t.status === status);
    col.innerHTML = '';
    tasks.forEach(task => {
      const card = buildTaskCard(task);
      card.draggable = true;
      card.addEventListener('dragstart', () => { dragTaskId = task.id; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { dragTaskId = null; card.classList.remove('dragging'); });
      col.appendChild(card);
    });
    // Inline add button at bottom of column
    const addBtn = document.createElement('button');
    addBtn.className = 'kanban-col-add-btn';
    addBtn.textContent = '+ Add task';
    addBtn.addEventListener('click', () => openTaskPanel(null, wsId, status));
    col.appendChild(addBtn);

    const count = document.querySelector(`.kanban-col[data-status="${status}"] .kanban-col-count`);
    if (count) count.textContent = tasks.length;
  });

  // Drop zones
  document.querySelectorAll('.kanban-cards').forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (!dragTaskId) return;
      const newStatus = zone.dataset.status;
      const task = state.tasks.find(t => t.id === dragTaskId);
      if (task && task.status !== newStatus) {
        const wasNotDone = task.status !== 'Done';
        task.status = newStatus;
        if (newStatus === 'Done') {
          task.completedAt = new Date().toISOString();
          if (wasNotDone && task.repeat && task.repeatNext) spawnNextOccurrence(task);
        } else {
          task.completedAt = null;
        }
        await saveData();
        renderKanban(wsId);
      }
    });
  });
}

// ===== All Tasks view =====
function renderAllTasks() {
  const searchVal = document.getElementById('search-input').value.toLowerCase();
  const filterWs = document.getElementById('filter-workspace').value;
  const filterStatus = document.getElementById('filter-status').value;
  const filterPriority = document.getElementById('filter-priority').value;
  const filterType = document.getElementById('filter-content-type').value;
  const sortBy = document.getElementById('sort-by').value;

  let tasks = state.tasks.filter(t => {
    if (filterWs && t.workspaceId !== filterWs) return false;
    if (filterStatus && t.status !== filterStatus) return false;
    if (filterPriority && t.priority !== filterPriority) return false;
    if (filterType && t.contentType !== filterType) return false;
    if (searchVal && !t.title.toLowerCase().includes(searchVal) && !t.notes?.toLowerCase().includes(searchVal)) return false;
    return true;
  });

  const priorityOrder = { High: 0, Medium: 1, Low: 2, '': 3 };
  tasks.sort((a, b) => {
    if (sortBy === 'dueDate') return (a.dueDate || 'z').localeCompare(b.dueDate || 'z');
    if (sortBy === 'priority') return (priorityOrder[a.priority || ''] ?? 3) - (priorityOrder[b.priority || ''] ?? 3);
    if (sortBy === 'createdAt') return b.createdAt.localeCompare(a.createdAt);
    if (sortBy === 'workspace') {
      const wa = getWorkspace(a.workspaceId)?.name || '';
      const wb = getWorkspace(b.workspaceId)?.name || '';
      return wa.localeCompare(wb);
    }
    return 0;
  });

  const list = document.getElementById('all-tasks-list');
  list.innerHTML = '';
  const t = today();

  tasks.forEach(task => {
    const ws = getWorkspace(task.workspaceId);
    const status = getDeadlineStatus(task.dueDate, task.status);
    const item = document.createElement('div');
    item.className = `task-list-item${status === 'overdue' ? ' overdue' : status === 'due-today' ? ' due-today' : ''}${task.status === 'Done' ? ' done' : ''}`;
    const dueDisplay = task.dueDate ? isoToDisplay(task.dueDate) : '';
    const priorityHtml = task.priority ? `<span class="priority-badge ${task.priority.toLowerCase()}">${task.priority}</span>` : '';
    item.innerHTML = `
      <button class="task-check${task.status === 'Done' ? ' checked' : ''}" title="${task.status === 'Done' ? 'Mark incomplete' : 'Mark done'}"></button>
      <span class="task-list-item-title">${escHtml(task.title)}</span>
      ${priorityHtml}
      <span class="content-type-tag" style="display:${task.contentType ? 'inline' : 'none'}">${task.contentType || ''}</span>
      <span class="task-list-item-ws">
        <span class="ws-dot" style="background:${ws?.color || '#6b7280'}"></span>
        ${escHtml(ws?.name || '')}
      </span>
      <span class="due-label${status === 'overdue' ? ' overdue' : status === 'due-today' ? ' due-today' : ''}" style="flex-shrink:0">${dueDisplay}</span>
    `;
    item.querySelector('.task-check').addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleTaskDone(task.id);
    });
    item.addEventListener('click', () => openTaskPanel(task.id));
    list.appendChild(item);
  });
}

['search-input','filter-workspace','filter-status','filter-priority','filter-content-type','sort-by'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', renderAllTasks);
  document.getElementById(id)?.addEventListener('change', renderAllTasks);
});

// ===== Weekly view =====
function renderWeekly() {
  const grid = document.getElementById('weekly-grid');
  grid.innerHTML = '';
  const t = today();
  const date = new Date();
  const dayOfWeek = date.getDay(); // 0=Sun
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((dayOfWeek + 6) % 7));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }

  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  days.forEach((d, i) => {
    const ds = d.toISOString().slice(0, 10);
    const isToday = ds === t;
    const col = document.createElement('div');
    col.className = 'weekly-day';
    const header = document.createElement('div');
    header.className = 'weekly-day-header' + (isToday ? ' today' : '');
    header.textContent = `${dayNames[i]} ${d.getDate()}`;
    col.appendChild(header);
    const dayTasks = state.tasks.filter(task => task.dueDate === ds && task.status !== 'Done');
    dayTasks.forEach(task => col.appendChild(buildTaskCard(task)));
    grid.appendChild(col);
  });

  // Unscheduled column
  const unscheduledCol = document.createElement('div');
  unscheduledCol.className = 'weekly-day';
  const uh = document.createElement('div');
  uh.className = 'weekly-day-header';
  uh.textContent = 'Unscheduled';
  unscheduledCol.appendChild(uh);
  const unscheduled = state.tasks.filter(t => !t.dueDate && t.status !== 'Done');
  unscheduled.forEach(task => unscheduledCol.appendChild(buildTaskCard(task)));
  grid.appendChild(unscheduledCol);
}

// ===== Settings view =====
function renderSettings() {
  document.getElementById('settings-username').textContent = ghUsername;
  document.getElementById('show-archived-toggle').checked = showArchived;
  renderTemplateList();
}

document.getElementById('show-archived-toggle').addEventListener('change', (e) => {
  showArchived = e.target.checked;
  renderSidebar();
});

document.getElementById('settings-logout').addEventListener('click', () => {
  if (confirm('Disconnect your GitHub account? All local data will be cleared.')) {
    localStorage.removeItem('gh_token');
    localStorage.removeItem('gh_username');
    location.reload();
  }
});

// ===== Task panel =====
function openTaskPanel(taskId = null, defaultWorkspaceId = null, defaultStatus = null) {
  editingTaskId = taskId;
  const task = taskId ? state.tasks.find(t => t.id === taskId) : null;

  document.getElementById('panel-title').textContent = task ? 'Edit Task' : 'New Task';
  document.getElementById('task-title').value = task?.title || '';
  document.getElementById('task-workspace').value = task?.workspaceId || defaultWorkspaceId || currentWorkspaceId || (state.workspaces[0]?.id || '');
  document.getElementById('task-status').value = task?.status || defaultStatus || 'Not Started';
  document.getElementById('task-priority').value = task?.priority || '';
  document.getElementById('task-due-date').value = task?.dueDate || '';
  document.getElementById('task-content-type').value = task?.contentType || '';
  document.getElementById('task-repeat').value = task?.repeat || '';
  document.getElementById('task-notes').value = task?.notes || '';

  const deleteBtn = document.getElementById('delete-task-btn');
  deleteBtn.classList.toggle('hidden', !taskId);

  renderSubtasksList(task?.subtasks || []);

  document.getElementById('task-panel').classList.remove('hidden');
  document.getElementById('task-panel-overlay').classList.remove('hidden');
  document.getElementById('task-title').focus();
}

function renderSubtasksList(subtasks) {
  const list = document.getElementById('subtasks-list');
  list.innerHTML = '';
  subtasks.forEach((st, i) => {
    list.appendChild(buildSubtaskRow(st.id, st.title, st.done));
  });
}

function buildSubtaskRow(id, title, done) {
  const row = document.createElement('div');
  row.className = 'subtask-row';
  row.dataset.id = id;
  row.innerHTML = `
    <input type="checkbox" ${done ? 'checked' : ''} />
    <input type="text" value="${escHtml(title)}" placeholder="Subtask…" />
    <button type="button" class="subtask-remove">✕</button>
  `;
  row.querySelector('.subtask-remove').addEventListener('click', () => row.remove());
  return row;
}

document.getElementById('add-subtask-btn').addEventListener('click', () => {
  const list = document.getElementById('subtasks-list');
  list.appendChild(buildSubtaskRow(uuid(), '', false));
  list.lastChild.querySelector('input[type="text"]').focus();
});

function closeTaskPanel() {
  document.getElementById('task-panel').classList.add('hidden');
  document.getElementById('task-panel-overlay').classList.add('hidden');
}

document.getElementById('close-panel-btn').addEventListener('click', closeTaskPanel);
document.getElementById('task-panel-overlay').addEventListener('click', closeTaskPanel);

document.getElementById('task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('task-title').value.trim();
  const workspaceId = document.getElementById('task-workspace').value;
  if (!title || !workspaceId) return;

  const subtasks = Array.from(document.getElementById('subtasks-list').querySelectorAll('.subtask-row')).map(row => ({
    id: row.dataset.id || uuid(),
    title: row.querySelector('input[type="text"]').value.trim(),
    done: row.querySelector('input[type="checkbox"]').checked,
  })).filter(s => s.title);

  const status = document.getElementById('task-status').value;
  const repeat = document.getElementById('task-repeat').value || null;
  const dueDate = document.getElementById('task-due-date').value || null;

  // repeatNext = first occurrence after the due date (or today if no due date)
  const repeatBase = dueDate || today();
  const repeatNext = repeat ? calculateNextOccurrence(repeatBase, repeat) : null;

  if (editingTaskId) {
    const task = state.tasks.find(t => t.id === editingTaskId);
    const wasNotDone = task.status !== 'Done';
    Object.assign(task, {
      title, workspaceId, status,
      priority: document.getElementById('task-priority').value || null,
      dueDate,
      contentType: document.getElementById('task-content-type').value || null,
      notes: document.getElementById('task-notes').value,
      subtasks,
      repeat,
      repeatNext,
      completedAt: status === 'Done' ? (task.completedAt || new Date().toISOString()) : null,
    });
    // If just marked Done and has a repeat, spawn next immediately
    if (status === 'Done' && wasNotDone && repeat && repeatNext) {
      spawnNextOccurrence(task);
    }
  } else {
    state.tasks.push({
      id: uuid(),
      title, workspaceId, status,
      priority: document.getElementById('task-priority').value || null,
      dueDate,
      contentType: document.getElementById('task-content-type').value || null,
      notes: document.getElementById('task-notes').value,
      subtasks,
      repeat,
      repeatNext,
      createdAt: new Date().toISOString(),
      completedAt: status === 'Done' ? new Date().toISOString() : null,
    });
  }

  await saveData();
  closeTaskPanel();
  refreshCurrentView();
});

document.getElementById('delete-task-btn').addEventListener('click', async () => {
  if (!editingTaskId) return;
  if (!confirm('Delete this task?')) return;
  state.tasks = state.tasks.filter(t => t.id !== editingTaskId);
  await saveData();
  closeTaskPanel();
  refreshCurrentView();
});

async function toggleTaskDone(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const wasNotDone = task.status !== 'Done';
  task.status = wasNotDone ? 'Done' : 'Not Started';
  task.completedAt = wasNotDone ? new Date().toISOString() : null;
  if (wasNotDone && task.repeat && task.repeatNext) spawnNextOccurrence(task);
  await saveData();
  refreshCurrentView();
}

function refreshCurrentView() {
  if (currentView === 'today') renderToday();
  else if (currentView === 'workspace') renderKanban(currentWorkspaceId);
  else if (currentView === 'all-tasks') renderAllTasks();
  else if (currentView === 'weekly') renderWeekly();
}

// ===== Quick add =====
function openQuickAdd() {
  document.getElementById('qa-title').value = '';
  document.getElementById('qa-due-date').value = '';
  renderWorkspaceDropdowns();
  document.getElementById('quick-add').classList.remove('hidden');
  document.getElementById('quick-add-overlay').classList.remove('hidden');
  document.getElementById('qa-title').focus();
}

function closeQuickAdd() {
  document.getElementById('quick-add').classList.add('hidden');
  document.getElementById('quick-add-overlay').classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    openQuickAdd();
  }
  if (e.key === 'Escape') {
    closeQuickAdd();
    closeTaskPanel();
    closeModal('ws-modal');
    closeModal('digest-modal');
    closeModal('template-modal');
    closeModal('spawn-modal');
  }
});

document.getElementById('quick-add-overlay').addEventListener('click', closeQuickAdd);

document.getElementById('quick-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('qa-title').value.trim();
  const workspaceId = document.getElementById('qa-workspace').value;
  if (!title || !workspaceId) return;
  state.tasks.push({
    id: uuid(),
    title,
    workspaceId,
    status: 'Not Started',
    priority: null,
    dueDate: document.getElementById('qa-due-date').value || null,
    contentType: null,
    notes: '',
    subtasks: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  });
  await saveData();
  closeQuickAdd();
  refreshCurrentView();
});

// ===== Topbar / nav buttons =====
document.getElementById('topbar-add-btn').addEventListener('click', () => openTaskPanel(null));
document.getElementById('fab').addEventListener('click', () => openTaskPanel(null));
document.getElementById('mobile-add-btn')?.addEventListener('click', (e) => { e.preventDefault(); openTaskPanel(null); });

document.querySelectorAll('.nav-item[data-view], .bottom-nav-item[data-view]').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const view = item.dataset.view;
    if (view) navigateTo(view);
  });
});

document.getElementById('mobile-menu-btn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ===== Weekly digest =====
document.getElementById('weekly-digest-btn').addEventListener('click', () => {
  const now = new Date();
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString();
  const todayStr = today();

  let text = `Weekly Digest — ${todayStr}\n${'='.repeat(40)}\n\n`;

  state.workspaces.filter(w => !w.archived).sort((a, b) => a.order - b.order).forEach(ws => {
    const wsTasks = state.tasks.filter(t => t.workspaceId === ws.id);
    const completed = wsTasks.filter(t => t.status === 'Done' && t.completedAt >= weekAgoStr);
    const inProgress = wsTasks.filter(t => t.status === 'In Progress' || t.status === 'With Client');
    const overdue = wsTasks.filter(t => t.dueDate && t.dueDate < todayStr && t.status !== 'Done');

    if (!completed.length && !inProgress.length && !overdue.length) return;

    text += `## ${ws.name}\n`;
    if (completed.length) {
      text += `  ✅ Completed this week:\n`;
      completed.forEach(t => { text += `    - ${t.title}\n`; });
    }
    if (inProgress.length) {
      text += `  🔄 In progress:\n`;
      inProgress.forEach(t => { text += `    - ${t.title}${t.dueDate ? ' (due ' + isoToDisplay(t.dueDate) + ')' : ''}\n`; });
    }
    if (overdue.length) {
      text += `  🔴 Overdue:\n`;
      overdue.forEach(t => { text += `    - ${t.title} (was due ${isoToDisplay(t.dueDate)})\n`; });
    }
    text += '\n';
  });

  document.getElementById('digest-content').textContent = text;
  showModal('digest-modal');
});

document.getElementById('copy-digest-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('digest-content').textContent)
    .then(() => { document.getElementById('copy-digest-btn').textContent = 'Copied!'; setTimeout(() => document.getElementById('copy-digest-btn').textContent = 'Copy to Clipboard', 2000); });
});
document.getElementById('close-digest-btn').addEventListener('click', () => closeModal('digest-modal'));
document.getElementById('close-digest-btn2').addEventListener('click', () => closeModal('digest-modal'));
document.getElementById('digest-overlay').addEventListener('click', () => closeModal('digest-modal'));

// ===== Templates =====
function renderTemplateList() {
  const list = document.getElementById('templates-list');
  list.innerHTML = '';
  state.templates.forEach(tpl => {
    const item = document.createElement('div');
    item.className = 'template-item';
    item.innerHTML = `
      <div>
        <div class="template-item-name">${escHtml(tpl.name)}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${tpl.subtasks.join(' · ')}</div>
      </div>
      <div class="template-item-actions">
        <button class="btn-ghost btn-sm" data-action="use">Use</button>
        <button class="btn-ghost btn-sm" data-action="edit">Edit</button>
        <button class="btn-ghost btn-sm" data-action="delete">Delete</button>
      </div>
    `;
    item.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => handleTemplateAction(tpl.id, btn.dataset.action));
    });
    list.appendChild(item);
  });
}

function handleTemplateAction(tplId, action) {
  const tpl = state.templates.find(t => t.id === tplId);
  if (!tpl) return;
  if (action === 'use') {
    spawnTemplateId = tplId;
    document.getElementById('spawn-title').value = tpl.name;
    document.getElementById('spawn-due-date').value = '';
    renderWorkspaceDropdowns();
    showModal('spawn-modal');
  } else if (action === 'edit') {
    openTemplateModal(tplId);
  } else if (action === 'delete') {
    if (confirm(`Delete template "${tpl.name}"?`)) {
      state.templates = state.templates.filter(t => t.id !== tplId);
      saveData();
      renderTemplateList();
    }
  }
}

function openTemplateModal(tplId = null) {
  editingTemplateId = tplId;
  const tpl = tplId ? state.templates.find(t => t.id === tplId) : null;
  document.getElementById('template-modal-title').textContent = tpl ? 'Edit Template' : 'New Template';
  document.getElementById('template-name').value = tpl?.name || '';
  const subList = document.getElementById('template-subtasks-list');
  subList.innerHTML = '';
  (tpl?.subtasks || []).forEach(title => addTemplateSubtaskRow(title));
  showModal('template-modal');
}

function addTemplateSubtaskRow(title = '') {
  const subList = document.getElementById('template-subtasks-list');
  const row = document.createElement('div');
  row.className = 'subtask-row';
  row.innerHTML = `<input type="text" value="${escHtml(title)}" placeholder="Subtask…" style="flex:1" /><button type="button" class="subtask-remove">✕</button>`;
  row.querySelector('.subtask-remove').addEventListener('click', () => row.remove());
  subList.appendChild(row);
}

document.getElementById('add-template-subtask-btn').addEventListener('click', () => addTemplateSubtaskRow());
document.getElementById('add-template-btn').addEventListener('click', () => openTemplateModal());
document.getElementById('close-template-modal').addEventListener('click', () => closeModal('template-modal'));
document.getElementById('cancel-template-modal').addEventListener('click', () => closeModal('template-modal'));
document.getElementById('template-overlay').addEventListener('click', () => closeModal('template-modal'));

document.getElementById('save-template-btn').addEventListener('click', async () => {
  const name = document.getElementById('template-name').value.trim();
  if (!name) return;
  const subtasks = Array.from(document.getElementById('template-subtasks-list').querySelectorAll('input[type="text"]'))
    .map(i => i.value.trim()).filter(Boolean);

  if (editingTemplateId) {
    const tpl = state.templates.find(t => t.id === editingTemplateId);
    tpl.name = name;
    tpl.subtasks = subtasks;
  } else {
    state.templates.push({ id: uuid(), name, subtasks });
  }
  await saveData();
  renderTemplateList();
  closeModal('template-modal');
});

document.getElementById('confirm-spawn-btn').addEventListener('click', async () => {
  if (!spawnTemplateId) return;
  const tpl = state.templates.find(t => t.id === spawnTemplateId);
  const title = document.getElementById('spawn-title').value.trim() || tpl.name;
  const workspaceId = document.getElementById('spawn-workspace').value;
  const dueDate = document.getElementById('spawn-due-date').value || null;
  if (!workspaceId) return;

  state.tasks.push({
    id: uuid(),
    title,
    workspaceId,
    status: 'Not Started',
    priority: null,
    dueDate,
    contentType: null,
    notes: '',
    subtasks: tpl.subtasks.map(s => ({ id: uuid(), title: s, done: false })),
    createdAt: new Date().toISOString(),
    completedAt: null,
  });
  await saveData();
  closeModal('spawn-modal');
  refreshCurrentView();
});
document.getElementById('close-spawn-modal').addEventListener('click', () => closeModal('spawn-modal'));
document.getElementById('cancel-spawn-modal').addEventListener('click', () => closeModal('spawn-modal'));
document.getElementById('spawn-overlay').addEventListener('click', () => closeModal('spawn-modal'));

// ===== CSV Export =====
document.getElementById('export-csv-btn').addEventListener('click', () => {
  const headers = ['Title','Workspace','Status','Priority','Due Date','Content Type','Notes','Created At','Completed At'];
  const rows = state.tasks.map(t => {
    const ws = getWorkspace(t.workspaceId);
    return [t.title, ws?.name || '', t.status, t.priority || '', t.dueDate || '', t.contentType || '', t.notes || '', t.createdAt, t.completedAt || ''];
  });
  const csv = [headers, ...rows].map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `plate-export-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ===== Modal helpers =====
function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  const overlay = document.getElementById(id.replace('-modal', '-overlay') || id + '-overlay');
  if (overlay) overlay.classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  const overlay = document.getElementById(id.replace('-modal', '-overlay') || id + '-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ===== HTML escape =====
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== Service worker — unregister any stale SW then skip registration =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
}

// ===== Start =====
init();
