let bearerToken = '';

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendEmptyState(node, message) {
  clearElement(node);
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  node.appendChild(empty);
}

function appendText(node, className, text) {
  const element = document.createElement('div');
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  node.appendChild(element);
  return element;
}

function createBadge(text, risk) {
  const badge = document.createElement('span');
  badge.className = `badge badge-${risk}`;
  badge.textContent = text;
  return badge;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function apiFetch(path, options = {}) {
  if (!bearerToken) {
    throw new Error(
      'Set the reviewer bearer token from ~/.agent-mail/reviewer-token to load data.'
    );
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${bearerToken}`);

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Authentication failed. Check the bearer token and try again.');
  }
  return response;
}

function setToken() {
  const tokenInput = document.getElementById('token-input');
  bearerToken = tokenInput.value.trim();
  tokenInput.value = '';
  loadActiveTab();
}

function showTab(event, name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
  event.currentTarget.classList.add('active');
  document.getElementById(`${name}-tab`).classList.add('active');
  loadActiveTab();
}

function renderPendingIntents(intents) {
  const list = document.getElementById('pending-list');
  if (intents.length === 0) {
    appendEmptyState(list, 'No pending actions');
    return;
  }

  clearElement(list);
  intents.forEach((intent) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = `card-${intent.id}`;

    const header = document.createElement('div');
    header.className = 'card-header';
    header.appendChild(createBadge(intent.tool, intent.risk));
    header.appendChild(createBadge(intent.risk, intent.risk));
    card.appendChild(header);

    appendText(card, 'card-title', `${intent.tool} on ${intent.account_id}`);
    appendText(card, 'card-detail', JSON.stringify(intent.params, null, 2));
    appendText(
      card,
      'card-meta',
      `Intent: ${intent.id.substring(0, 8)}... | Created: ${new Date(intent.created_at).toLocaleString()}`
    );

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const approveButton = document.createElement('button');
    approveButton.className = 'btn btn-approve';
    approveButton.type = 'button';
    approveButton.textContent = 'Approve';
    approveButton.addEventListener('click', () => {
      void approveIntent(intent.id);
    });
    actions.appendChild(approveButton);

    const rejectButton = document.createElement('button');
    rejectButton.className = 'btn btn-reject';
    rejectButton.type = 'button';
    rejectButton.textContent = 'Reject';
    rejectButton.addEventListener('click', () => {
      void rejectIntent(intent.id);
    });
    actions.appendChild(rejectButton);

    card.appendChild(actions);
    list.appendChild(card);
  });
}

function renderAuditLog(entries) {
  const list = document.getElementById('audit-list');
  if (entries.length === 0) {
    appendEmptyState(list, 'No audit log entries');
    return;
  }

  clearElement(list);
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'audit-row';

    const left = document.createElement('span');
    const action = document.createElement('span');
    action.className = 'audit-action';
    action.textContent = entry.action;
    left.appendChild(action);
    left.appendChild(
      document.createTextNode(
        ` by ${entry.actor}${entry.account_id ? ` (${entry.account_id})` : ''}`
      )
    );

    const right = document.createElement('span');
    right.className = 'audit-time';
    right.textContent = new Date(entry.created_at).toLocaleString();

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
  });
}

function renderStuckIntents(stuck) {
  const list = document.getElementById('stuck-list');
  if (stuck.length === 0) {
    appendEmptyState(list, 'No stuck intents');
    return;
  }

  clearElement(list);
  stuck.forEach((intent) => {
    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';
    header.appendChild(createBadge(`${intent.tool} (stuck)`, 'high'));
    card.appendChild(header);

    appendText(card, 'card-detail', JSON.stringify(intent.params, null, 2));
    appendText(
      card,
      'card-meta',
      `Intent: ${intent.id.substring(0, 8)}... | Account: ${intent.account_id}`
    );
    list.appendChild(card);
  });
}

async function loadPending() {
  const list = document.getElementById('pending-list');
  try {
    const res = await apiFetch('/api/pending');
    renderPendingIntents(await res.json());
  } catch (error) {
    appendEmptyState(list, formatError(error));
  }
}

async function loadAuditLog() {
  const list = document.getElementById('audit-list');
  try {
    const res = await apiFetch('/api/audit?limit=50');
    renderAuditLog(await res.json());
  } catch (error) {
    appendEmptyState(list, formatError(error));
  }
}

async function loadStuck() {
  const list = document.getElementById('stuck-list');
  try {
    const res = await apiFetch('/api/stuck');
    renderStuckIntents(await res.json());
  } catch (error) {
    appendEmptyState(list, formatError(error));
  }
}

async function approveIntent(id) {
  try {
    const res = await apiFetch(`/api/intent/${id}/approve`, {
      method: 'POST',
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Approve failed: ${err.error}`);
      return;
    }
    await loadPending();
  } catch (error) {
    alert(`Error: ${formatError(error)}`);
  }
}

async function rejectIntent(id) {
  try {
    const res = await apiFetch(`/api/intent/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Rejected via reviewer UI' }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Reject failed: ${err.error}`);
      return;
    }
    await loadPending();
  } catch (error) {
    alert(`Error: ${formatError(error)}`);
  }
}

function loadActiveTab() {
  if (document.getElementById('pending-tab').classList.contains('active')) {
    void loadPending();
    return;
  }
  if (document.getElementById('audit-tab').classList.contains('active')) {
    void loadAuditLog();
    return;
  }
  if (document.getElementById('stuck-tab').classList.contains('active')) {
    void loadStuck();
  }
}

document.getElementById('set-token-button').addEventListener('click', setToken);
document.getElementById('token-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    setToken();
  }
});
document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', (event) => {
    showTab(event, button.dataset.tab);
  });
});

appendEmptyState(
  document.getElementById('pending-list'),
  'Set the reviewer bearer token from ~/.agent-mail/reviewer-token to load data.'
);

setInterval(() => {
  if (
    bearerToken &&
    document.getElementById('pending-tab').classList.contains('active')
  ) {
    void loadPending();
  }
}, 5000);
