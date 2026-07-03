const form = document.querySelector('#connectionForm');
const statusPill = document.querySelector('#statusPill');
const statusText = document.querySelector('#statusText');
const connectButton = document.querySelector('#connectButton');
const disconnectButton = document.querySelector('#disconnectButton');
const detectMacButton = document.querySelector('#detectMacButton');
const sendButton = document.querySelector('#sendButton');
const startLoopButton = document.querySelector('#startLoopButton');
const stopLoopButton = document.querySelector('#stopLoopButton');
const clearLogButton = document.querySelector('#clearLogButton');
const clearDataButton = document.querySelector('#clearDataButton');
const payload = document.querySelector('#payload');
const intervalMs = document.querySelector('#intervalMs');
const logView = document.querySelector('#logView');
const dataView = document.querySelector('#dataView');
const sentCount = document.querySelector('#sentCount');
const receivedCount = document.querySelector('#receivedCount');
const disconnectCount = document.querySelector('#disconnectCount');
const latency = document.querySelector('#latency');
const macAddress = document.querySelector('#macAddress');

let connected = false;
let loopRunning = false;

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function getConfig() {
  return {
    host: document.querySelector('#host').value.trim(),
    port: Number(document.querySelector('#port').value),
    timeoutMs: Number(document.querySelector('#timeoutMs').value),
    reconnectMs: Number(document.querySelector('#reconnectMs').value),
    autoReconnect: document.querySelector('#autoReconnect').checked
  };
}

function setStatus(state) {
  const labels = {
    connected: 'Conectado',
    connecting: 'Conectando',
    reconnecting: 'Reconectando',
    timeout: 'Timeout',
    error: 'Error',
    disconnected: 'Desconectado'
  };

  statusPill.className = `status-pill ${state || 'disconnected'}`;
  statusText.textContent = labels[state] || labels.disconnected;
}

function setControls() {
  connectButton.disabled = connected;
  disconnectButton.disabled = !connected && !loopRunning;
  detectMacButton.disabled = false;
  sendButton.disabled = !connected;
  startLoopButton.disabled = !connected || loopRunning;
  stopLoopButton.disabled = !loopRunning;
}

function renderStats(stats = {}) {
  sentCount.textContent = stats.sent ?? 0;
  receivedCount.textContent = stats.received ?? 0;
  disconnectCount.textContent = stats.disconnects ?? 0;
  latency.textContent = stats.lastLatencyMs == null ? '--' : `${stats.lastLatencyMs} ms`;
}

function timeLabel(value) {
  return new Date(value).toLocaleTimeString('es-MX', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function appendLog(entry) {
  const row = document.createElement('div');
  row.className = `log-entry ${entry.level || 'info'}`;
  row.innerHTML = `<span class="stamp">${timeLabel(entry.at)}</span> ${escapeHtml(entry.message)}`;
  logView.prepend(row);
}

function appendData(entry) {
  const empty = dataView.querySelector('.empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = 'data-entry';
  row.innerHTML = [
    `<div><span class="stamp">${timeLabel(entry.at)}</span> ${entry.bytes} bytes</div>`,
    `<div>HEX: ${escapeHtml(entry.hex)}</div>`,
    `<div>TXT: ${escapeHtml(entry.text)}</div>`
  ].join('');
  dataView.prepend(row);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    appendLog({
      level: 'error',
      message: error.message || 'Operacion fallida.',
      at: new Date().toISOString()
    });
  }
}

async function detectMac() {
  macAddress.textContent = 'Buscando...';
  try {
    const result = await window.plcApi.detectMac({ host: getConfig().host });
    macAddress.textContent = result.mac || 'No detectada';
  } catch (error) {
    macAddress.textContent = 'No detectada';
    throw error;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAction(async () => {
    await window.plcApi.connect(getConfig());
    await detectMac();
  });
});

detectMacButton.addEventListener('click', () => {
  runAction(detectMac);
});

disconnectButton.addEventListener('click', () => {
  runAction(() => window.plcApi.disconnect());
});

sendButton.addEventListener('click', () => {
  runAction(() => window.plcApi.send({
    payload: payload.value,
    mode: getMode()
  }));
});

startLoopButton.addEventListener('click', () => {
  runAction(() => window.plcApi.startLoop({
    payload: payload.value,
    mode: getMode(),
    intervalMs: Number(intervalMs.value)
  }));
});

stopLoopButton.addEventListener('click', () => {
  runAction(() => window.plcApi.stopLoop());
});

clearLogButton.addEventListener('click', () => {
  logView.innerHTML = '';
});

clearDataButton.addEventListener('click', () => {
  dataView.innerHTML = '<p class="empty">Sin datos recibidos.</p>';
});

window.plcApi.on('plc:status', (status) => {
  connected = Boolean(status.connected);
  setStatus(status.state);
  renderStats(status.stats);
  setControls();
});

window.plcApi.on('plc:log', appendLog);
window.plcApi.on('plc:data', (entry) => {
  appendData(entry);
  renderStats(entry.stats);
});

window.plcApi.on('plc:loop', (state) => {
  loopRunning = Boolean(state.running);
  setControls();
});

window.plcApi.getStatus()
  .then((status) => {
    connected = Boolean(status.connected);
    loopRunning = Boolean(status.loopRunning);
    setStatus(connected ? 'connected' : 'disconnected');
    renderStats(status.stats);
    setControls();
  })
  .catch((error) => {
    appendLog({
      level: 'error',
      message: error.message || 'No se pudo leer el estado inicial.',
      at: new Date().toISOString()
    });
  });
