let bearerToken = localStorage.getItem('agent-mail-token') || '';

function setToken() {
  bearerToken = document.getElementById('token-input').value;
  localStorage.setItem('agent-mail-token', bearerToken);
  document.getElementById('token-input').value = '';
  loadPending();
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById(name + '-tab').classList.add('active');

  if (name === 'pending') loadPending();
  if (name === 'audit') loadAuditLog();
  if (name === 'stuck') loadStuck();
}

function riskBadge(risk) {
  return `<span class="badge badge-${risk}">${risk}</span>`;
}

async function loadPending() {
  try {
    const res = await fetch('/api/pending');
    const intents = await res.json();
    const list = document.getElementById('pending-list');

    if (intents.length === 0) {
      list.innerHTML = '<div class="empty">No pending actions</div>';
      return;
    }

    list.innerHTML = intents.map(i => `
      <div class="card" id="card-${i.id}">
        <div class="card-header">
          <span class="badge badge-${i.risk}">${i.tool}</span>
          ${riskBadge(i.risk)}
        </div>
        <div class="card-title">${i.tool} on ${i.account_id}</div>
        <div class="card-detail">${JSON.stringify(i.params, null, 2)}</div>
        <div class="card-meta">Intent: ${i.id.substring(0, 8)}... | Created: ${new Date(i.created_at).toLocaleString()}</div>
        <div class="card-actions">
          <button class="btn btn-approve" onclick="approveIntent('${i.id}')">Approve</button>
          <button class="btn btn-reject" onclick="rejectIntent('${i.id}')">Reject</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('pending-list').innerHTML =
      '<div class="empty">Failed to load pending actions</div>';
  }
}

async function loadAuditLog() {
  try {
    const res = await fetch('/api/audit?limit=50');
    const entries = await res.json();
    const list = document.getElementById('audit-list');

    if (entries.length === 0) {
      list.innerHTML = '<div class="empty">No audit log entries</div>';
      return;
    }

    list.innerHTML = entries.map(e => `
      <div class="audit-row">
        <span><span class="audit-action">${e.action}</span> by ${e.actor} ${e.account_id ? `(${e.account_id})` : ''}</span>
        <span class="audit-time">${new Date(e.created_at).toLocaleString()}</span>
      </div>
    `).join('');
  } catch {
    document.getElementById('audit-list').innerHTML =
      '<div class="empty">Failed to load audit log</div>';
  }
}

async function loadStuck() {
  try {
    const res = await fetch('/api/stuck');
    const stuck = await res.json();
    const list = document.getElementById('stuck-list');

    if (stuck.length === 0) {
      list.innerHTML = '<div class="empty">No stuck intents</div>';
      return;
    }

    list.innerHTML = stuck.map(i => `
      <div class="card">
        <div class="card-header">
          <span class="badge badge-high">${i.tool} (stuck)</span>
        </div>
        <div class="card-detail">${JSON.stringify(i.params, null, 2)}</div>
        <div class="card-meta">Intent: ${i.id.substring(0, 8)}... | Account: ${i.account_id}</div>
      </div>
    `).join('');
  } catch {
    document.getElementById('stuck-list').innerHTML =
      '<div class="empty">Failed to load stuck intents</div>';
  }
}

async function approveIntent(id) {
  try {
    const res = await fetch(`/api/intent/${id}/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Approve failed: ${err.error}`);
      return;
    }
    loadPending();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function rejectIntent(id) {
  try {
    const res = await fetch(`/api/intent/${id}/reject`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Rejected via reviewer UI' }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Reject failed: ${err.error}`);
      return;
    }
    loadPending();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

// Initial load
loadPending();

// Auto-refresh every 5 seconds
setInterval(() => {
  if (document.getElementById('pending-tab').classList.contains('active')) {
    loadPending();
  }
}, 5000);
