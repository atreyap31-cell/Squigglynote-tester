// Squiggly Note monitor. Test runs, tickets and recipients all live on the Squiggly
// server (the same one the note app uses), reached through its ngrok tunnel.
const DEFAULT_API = 'https://absolve-marigold-procedure.ngrok-free.dev';
const params = new URLSearchParams(location.search);
if (params.get('api')) localStorage.setItem('sqApi', params.get('api'));
let API = (localStorage.getItem('sqApi') || DEFAULT_API).replace(/\/+$/, '');

const $ = selector => document.querySelector(selector);
const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = iso => (iso ? new Date(iso).toLocaleString() : '');

let status = null;
let filter = 'all';
let pollTimer = null;

function showToast(text) {
  $('#toast').textContent = text;
  $('#toast').style.display = 'block';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => ($('#toast').style.display = 'none'), 3000);
}

async function api(path, { method = 'GET', body, admin = false, raw = false } = {}) {
  // Free ngrok tunnels show a warning page to browsers unless this header is sent.
  const headers = { 'ngrok-skip-browser-warning': 'true' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin) headers['X-Admin-Key'] = localStorage.getItem('sqAdminKey') || '';
  const response = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    let detail = 'HTTP ' + response.status;
    try { detail = (await response.json()).detail || detail; } catch {}
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return raw ? response : response.json();
}

// ------------------------------------------------------------------ monitor
async function refreshStatus() {
  try {
    status = await api('/monitor/status');
  } catch {
    status = null;
  }
  renderStatus();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshStatus, status?.running ? 3000 : 60000);
}

function renderStatus() {
  const state = $('#serverState');
  const run = status?.run;
  const button = $('#runNow');
  if (!status) {
    state.className = 'online down';
    state.innerHTML = '<i></i>Server offline';
    button.disabled = true;
    button.textContent = 'Run test now';
    $('#checks').innerHTML =
      '<div class="card"><p class="muted">The Squiggly server at <code>' + escapeHtml(API) +
      '</code> is not reachable. Start it on the host PC with <code>server\\start.ps1</code>.</p></div>';
    return;
  }
  const done = run?.checks.filter(c => !['PENDING', 'RUNNING'].includes(c.status)).length || 0;
  state.className = 'online ' + (status.running ? 'running' : 'up');
  state.innerHTML = '<i></i>' + (status.running ? 'Testing now' : 'Monitoring every ' + status.interval_hours + ' hours');
  button.disabled = status.running;
  button.textContent = status.running ? `Running… ${done}/${run.checks.length}` : 'Run test now';

  const count = s => run?.checks.filter(c => c.status === s).length || 0;
  $('#passed').textContent = count('PASS');
  $('#blocked').textContent = count('BLOCKED');
  $('#failed').textContent = count('FAIL');
  const site = $('#siteStatus');
  const up = run?.site_up ?? run?.checks.find(c => c.id === 'availability' && c.status === 'PASS') !== undefined;
  site.textContent = !run ? '—' : status.running && run.site_up === null ? '…' : up ? 'UP' : 'DOWN';
  site.className = !run ? '' : up ? 'green' : 'red';
  $('#lastRun').textContent = !run ? 'Not run yet' : run.finished ? 'Checked ' + when(run.finished) : 'Started ' + when(run.started);
  $('#nextRun').textContent = status.next_run ? 'Next run ' + when(status.next_run) : 'Latest run';
  renderChecks();
}

function renderChecks() {
  const run = status?.run;
  if (!run) {
    $('#checks').innerHTML = '<div class="card"><p class="muted">No test has run yet. Press Run test now.</p></div>';
    return;
  }
  const rows = run.checks.filter(c => filter === 'all' || c.status === filter);
  $('#checks').innerHTML =
    rows
      .map(
        c => `<div class="row"><div><h4>${escapeHtml(c.name)}</h4><p class="muted">${escapeHtml(c.detail)}</p>` +
          (c.message ? `<p class="message">${escapeHtml(c.message)}</p>` : '') +
          `</div><div class="actions">` +
          (c.evidence ? `<button type="button" data-evidence="${escapeHtml(c.evidence)}" data-name="${escapeHtml(c.name)}">Screenshot</button>` : '') +
          `<span class="status ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>` +
          `<span class="time">${c.time ? when(c.time) + (c.duration != null ? ' · ' + c.duration + 's' : '') : ''}</span></div></div>`,
      )
      .join('') || '<div class="card"><p class="muted">No checks match this filter.</p></div>';
  document.querySelectorAll('[data-evidence]').forEach(b => (b.onclick = () => showEvidence(b.dataset.evidence, b.dataset.name)));
}

async function showEvidence(name, title) {
  try {
    const blob = await (await api('/monitor/evidence/' + encodeURIComponent(name), { raw: true })).blob();
    const image = $('#evidenceImage');
    if (image.src) URL.revokeObjectURL(image.src);
    image.src = URL.createObjectURL(blob);
    $('#evidenceTitle').textContent = title;
    $('#evidenceDialog').showModal();
  } catch (error) {
    showToast('Could not load the screenshot: ' + error.message);
  }
}

$('#closeEvidence').onclick = () => $('#evidenceDialog').close();

$('#runNow').onclick = async () => {
  $('#runNow').disabled = true;
  try {
    status = await api('/monitor/run', { method: 'POST' });
    showToast(status.started ? 'Test started — this takes a few minutes.' : 'A test is already running.');
  } catch (error) {
    showToast(error.message);
  }
  refreshStatus();
};

document.querySelectorAll('[data-filter]').forEach(
  b =>
    (b.onclick = () => {
      document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      filter = b.dataset.filter;
      renderChecks();
    }),
);

// ------------------------------------------------------------------ tickets
async function renderTickets() {
  const list = $('#ticketList');
  try {
    const { tickets } = await api('/monitor/tickets');
    list.innerHTML = tickets.length
      ? tickets
          .map(
            t => `<div class="ticket"><div><small>${escapeHtml(t.id)} · ${when(t.time)}</small><h4>${escapeHtml(t.title)}</h4>` +
              `<p class="muted">Reported by ${escapeHtml(t.by)}${t.resolved ? ' · resolved ' + when(t.resolved) : ''}</p></div>` +
              `<div class="actions"><span class="ticket-status ${t.status.toLowerCase()}">${escapeHtml(t.status)}</span>` +
              (t.status !== 'Resolved' ? `<button type="button" data-resolve="${escapeHtml(t.uid)}">Mark resolved</button>` : '') +
              '</div></div>',
          )
          .join('')
      : '<div class="card"><p class="muted">No tickets yet.</p></div>';
    document.querySelectorAll('[data-resolve]').forEach(
      b =>
        (b.onclick = async () => {
          try {
            await api('/monitor/tickets/' + b.dataset.resolve + '/resolve', { method: 'POST' });
            showToast('Ticket marked resolved');
            renderTickets();
          } catch (error) {
            showToast(error.message);
          }
        }),
    );
  } catch {
    list.innerHTML = '<div class="card"><p class="muted">Tickets are unavailable while the server is offline.</p></div>';
  }
}

$('#ticketForm').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/monitor/tickets', { method: 'POST', body: { title: $('#ticketTitle').value, by: $('#ticketBy').value } });
    $('#ticketForm').reset();
    showToast('Ticket submitted');
    renderTickets();
  } catch (error) {
    showToast(error.message);
  }
};

// ------------------------------------------------------------------ recipients
async function renderRecipients() {
  const locked = !localStorage.getItem('sqAdminKey');
  $('#keyForm').hidden = !locked;
  $('#recipientPanel').hidden = locked;
  if (locked) return;
  try {
    const { recipients, email_configured } = await api('/monitor/recipients', { admin: true });
    $('#emailState').textContent = email_configured
      ? 'Email alerts are on.'
      : 'Email alerts are off until SMTP_USER and SMTP_PASSWORD are set in server\\.env on the host PC.';
    $('#recipients').innerHTML =
      recipients.map(e => `<button type="button" class="chip" title="Click to remove" data-email="${escapeHtml(e)}">${escapeHtml(e)} ×</button>`).join('') ||
      '<span class="muted">No recipients added.</span>';
    document.querySelectorAll('[data-email]').forEach(
      c =>
        (c.onclick = async () => {
          await api('/monitor/recipients/' + encodeURIComponent(c.dataset.email), { method: 'DELETE', admin: true });
          renderRecipients();
        }),
    );
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem('sqAdminKey');
      showToast('That admin key was not accepted.');
      renderRecipients();
    } else {
      $('#recipients').innerHTML = '<span class="muted">Recipients are unavailable while the server is offline.</span>';
    }
  }
}

$('#keyForm').onsubmit = event => {
  event.preventDefault();
  localStorage.setItem('sqAdminKey', $('#adminKey').value.trim());
  $('#keyForm').reset();
  renderRecipients();
};

$('#emailForm').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/monitor/recipients', { method: 'POST', admin: true, body: { email: $('#newEmail').value } });
    $('#emailForm').reset();
    renderRecipients();
  } catch (error) {
    showToast(error.message);
  }
};

$('#testEmail').onclick = async () => {
  try {
    const { result } = await api('/monitor/test-email', { method: 'POST', admin: true });
    showToast(result === 'sent' ? 'Test email sent.' : result === 'skipped' ? 'Nothing to send: add a recipient and configure SMTP first.' : 'Email ' + result);
  } catch (error) {
    showToast(error.message);
  }
};

$('#lock').onclick = () => {
  localStorage.removeItem('sqAdminKey');
  renderRecipients();
};

// ------------------------------------------------------------------ tabs and server address
document.querySelectorAll('[data-tab]').forEach(
  b =>
    (b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.panel').forEach(x => x.classList.add('hidden'));
      $('#' + b.dataset.tab).classList.remove('hidden');
      if (b.dataset.tab === 'tickets') renderTickets();
      if (b.dataset.tab === 'settings') renderRecipients();
    }),
);

$('#apiUrl').textContent = API;
$('#changeApi').onclick = () => {
  const value = prompt('Squiggly server address', API);
  if (!value) return;
  API = value.trim().replace(/\/+$/, '');
  localStorage.setItem('sqApi', API);
  $('#apiUrl').textContent = API;
  refreshStatus();
};

refreshStatus();
