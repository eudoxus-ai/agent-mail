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
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...options, headers });
}

function showTab(event, name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
  event.currentTarget.classList.add('active');
  document.getElementById(`${name}-tab`).classList.add('active');
  loadActiveTab();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatIntentTitle(intent) {
  const p = intent.params;
  switch (intent.tool) {
    case 'queue_send':
      return `Send email to ${p.to || 'unknown'}`;
    case 'quarantine_thread': {
      const count = Array.isArray(p.uids) ? p.uids.length : 0;
      return `Quarantine ${count} message${count !== 1 ? 's' : ''}`;
    }
    case 'permanent_delete': {
      const count = Array.isArray(p.uids) ? p.uids.length : 0;
      return `Permanently delete ${count} item${count !== 1 ? 's' : ''}`;
    }
    default:
      return `${intent.tool} on ${intent.account_id}`;
  }
}

function formatIntentDetail(intent) {
  const p = intent.params;
  switch (intent.tool) {
    case 'queue_send':
      return `<div class="intent-field"><span class="field-label">Subject:</span> ${escapeHtml(p.subject || '(no subject)')}</div>`
        + `<div class="intent-field"><span class="field-label">Body:</span></div>`
        + `<div class="intent-body">${escapeHtml(p.body || '').substring(0, 500)}</div>`;
    default:
      return `<pre>${escapeHtml(JSON.stringify(p, null, 2))}</pre>`;
  }
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
    header.appendChild(createBadge(intent.tool, 'none'));
    header.appendChild(createBadge(intent.risk, intent.risk));
    card.appendChild(header);

    const titleEl = document.createElement('div');
    titleEl.className = 'card-title card-title-link';
    titleEl.textContent = formatIntentTitle(intent);
    titleEl.addEventListener('click', () => showIntentDetail(intent));
    card.appendChild(titleEl);
    const detail = document.createElement('div');
    detail.className = 'card-detail';
    detail.innerHTML = formatIntentDetail(intent);
    card.appendChild(detail);
    appendText(
      card,
      'card-meta',
      `${intent.account_id} · ${new Date(intent.created_at).toLocaleString()}`
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
    const summary = entry.detail?.summary;
    if (summary) {
      const summaryEl = document.createElement('strong');
      summaryEl.textContent = summary;
      left.appendChild(summaryEl);
      const action = document.createElement('span');
      action.className = 'audit-action';
      action.textContent = ` · ${entry.action}`;
      left.appendChild(action);
    } else {
      const action = document.createElement('span');
      action.className = 'audit-action';
      action.textContent = entry.action;
      left.appendChild(action);
      left.appendChild(
        document.createTextNode(
          ` by ${entry.actor}${entry.account_id ? ` (${entry.account_id})` : ''}`
        )
      );
    }

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

function showIntentDetail(intent) {
  // Hide tabs, show detail view
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('intent-detail-tab').classList.add('active');

  const container = document.getElementById('intent-detail');
  clearElement(container);

  const backBtn = document.createElement('button');
  backBtn.className = 'btn';
  backBtn.textContent = '\u2190 Back to Pending';
  backBtn.addEventListener('click', () => {
    document.getElementById('intent-detail-tab').classList.remove('active');
    document.querySelector('[data-tab="pending"]').click();
  });
  container.appendChild(backBtn);

  const p = intent.params;

  if (intent.tool === 'queue_send') {
    const header = document.createElement('div');
    header.className = 'detail-header';
    header.innerHTML = `<span>Send email from <strong>${escapeHtml(intent.account_id)}</strong></span>
      <span class="audit-time">${new Date(intent.created_at).toLocaleString()}</span>`;
    container.appendChild(header);

    const form = document.createElement('div');
    form.className = 'detail-form';
    form.innerHTML = `
      <div class="detail-field">
        <label>To</label>
        <input type="text" id="edit-to" value="${escapeHtml(p.to || '')}">
      </div>
      <div class="detail-field">
        <label>Subject</label>
        <input type="text" id="edit-subject" value="${escapeHtml(p.subject || '')}">
      </div>
      <div class="detail-field">
        <label>Body</label>
        <textarea id="edit-body" rows="10">${escapeHtml(p.body || '')}</textarea>
      </div>
    `;
    container.appendChild(form);

    if (p.in_reply_to) {
      const replyCtx = document.createElement('div');
      replyCtx.className = 'reply-context';
      replyCtx.innerHTML = `<div class="field-label">Replying to</div>
        <div class="reply-snippet">${escapeHtml(p.in_reply_to)}</div>`;
      container.appendChild(replyCtx);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      await rejectIntent(intent.id);
      document.querySelector('[data-tab="pending"]').click();
    });

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-approve';
    approveBtn.textContent = 'Approve & Send';
    approveBtn.addEventListener('click', async () => {
      const editedParams = {
        ...p,
        to: document.getElementById('edit-to').value,
        subject: document.getElementById('edit-subject').value,
        body: document.getElementById('edit-body').value,
      };
      await approveIntentWithParams(intent.id, editedParams);
      document.querySelector('[data-tab="pending"]').click();
    });

    actions.appendChild(rejectBtn);
    actions.appendChild(approveBtn);
    container.appendChild(actions);
  } else {
    // Generic detail for non-send intents
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = formatIntentTitle(intent);
    container.appendChild(title);

    const detail = document.createElement('div');
    detail.className = 'card-detail';
    detail.textContent = JSON.stringify(intent.params, null, 2);
    container.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      await rejectIntent(intent.id);
      document.querySelector('[data-tab="pending"]').click();
    });

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-approve';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', async () => {
      await approveIntent(intent.id);
      document.querySelector('[data-tab="pending"]').click();
    });

    actions.appendChild(rejectBtn);
    actions.appendChild(approveBtn);
    container.appendChild(actions);
  }
}

async function loadQuarantine() {
  try {
    const res = await apiFetch('/api/quarantine');
    const items = await res.json();
    renderQuarantine(items);
  } catch (error) {
    const list = document.getElementById('quarantine-list');
    appendEmptyState(list, `Error: ${formatError(error)}`);
  }
}

function renderQuarantine(intents) {
  const list = document.getElementById('quarantine-list');
  if (intents.length === 0) {
    appendEmptyState(list, 'No quarantined items');
    return;
  }

  clearElement(list);

  const header = document.createElement('div');
  header.className = 'quarantine-header';
  header.innerHTML = `<strong>${intents.length} item${intents.length !== 1 ? 's' : ''}</strong> in Quarantine`;
  list.appendChild(header);

  intents.forEach((intent) => {
    const row = document.createElement('div');
    row.className = 'quarantine-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.intentId = intent.id;

    const info = document.createElement('div');
    info.className = 'quarantine-info';

    const p = intent.params;
    const uidCount = Array.isArray(p.uids) ? p.uids.length : 0;
    const mailbox = p.mailbox || 'INBOX';
    info.innerHTML = `<div>${escapeHtml(intent.tool)} · ${uidCount} message${uidCount !== 1 ? 's' : ''} from ${escapeHtml(mailbox)}</div>
      <div class="audit-time">${new Date(intent.created_at).toLocaleString()}</div>`;

    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/intent/${intent.id}/undo`, { method: 'POST' });
        await loadQuarantine();
      } catch (error) {
        alert(`Error: ${formatError(error)}`);
      }
    });

    row.appendChild(checkbox);
    row.appendChild(info);
    row.appendChild(undoBtn);
    list.appendChild(row);
  });
}

async function approveIntentWithParams(id, params) {
  try {
    const res = await apiFetch(`/api/intent/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ params }),
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
    return;
  }
  if (document.getElementById('quarantine-tab').classList.contains('active')) {
    void loadQuarantine();
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', (event) => {
    showTab(event, button.dataset.tab);
  });
});

loadActiveTab();

setInterval(() => {
  if (document.getElementById('pending-tab').classList.contains('active')) {
    void loadPending();
  }
}, 5000);
