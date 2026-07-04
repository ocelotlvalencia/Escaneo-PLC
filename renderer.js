const form = document.querySelector('#connectionForm');
const statusPill = document.querySelector('#statusPill');
const statusText = document.querySelector('#statusText');
const connectButton = document.querySelector('#connectButton');
const disconnectButton = document.querySelector('#disconnectButton');
const detectMacButton = document.querySelector('#detectMacButton');
const writeCounterButton = document.querySelector('#writeCounterButton');
const incrementCounterButton = document.querySelector('#incrementCounterButton');
const decrementCounterButton = document.querySelector('#decrementCounterButton');
const clearLogButton = document.querySelector('#clearLogButton');
const clearDataButton = document.querySelector('#clearDataButton');
const counterValue = document.querySelector('#counterValue');
const modbusRegister = document.querySelector('#modbusRegister');
const unitId = document.querySelector('#unitId');
const lastCounterValue = document.querySelector('#lastCounterValue');
const lastDisconnectAt = document.querySelector('#lastDisconnectAt');
const lastDowntime = document.querySelector('#lastDowntime');
const lastDisconnectReason = document.querySelector('#lastDisconnectReason');
const logView = document.querySelector('#logView');
const dataView = document.querySelector('#dataView');
const sentCount = document.querySelector('#sentCount');
const receivedCount = document.querySelector('#receivedCount');
const disconnectCount = document.querySelector('#disconnectCount');
const latency = document.querySelector('#latency');
const statusSeconds = document.querySelector('#statusSeconds');
const macAddress = document.querySelector('#macAddress');

let connected = false;

function getConfig() {
  return {
    host: document.querySelector('#host').value.trim(),
    port: Number(document.querySelector('#port').value),
    timeoutMs: Number(document.querySelector('#timeoutMs').value),
    reconnectMs: Number(document.querySelector('#reconnectMs').value),
    autoReconnect: document.querySelector('#autoReconnect').checked
  };
}

function getCounterRequest() {
  return {
    ...getConfig(),
    value: Number(counterValue.value),
    register: Number(modbusRegister.value),
    unitId: Number(unitId.value)
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

function setStatusTiming(status = {}) {
  const seconds = Number(status.connected ? status.connectedSeconds : status.stateSeconds) || 0;
  const labels = {
    connected: 'Conectado',
    connecting: 'Conectando',
    reconnecting: 'Reconectando',
    timeout: 'Timeout',
    error: 'Error',
    disconnected: 'Sin conexion'
  };
  const label = labels[status.state] || (status.connected ? 'Conectado' : 'Sin conexion');

  statusSeconds.textContent = `${seconds}s`;
  statusText.textContent = `${label} ${seconds}s`;
}

function setControls() {
  connectButton.disabled = connected;
  disconnectButton.disabled = !connected;
  detectMacButton.disabled = false;
  writeCounterButton.disabled = !connected;
}

function renderStats(stats = {}) {
  sentCount.textContent = stats.sent ?? 0;
  receivedCount.textContent = stats.received ?? 0;
  disconnectCount.textContent = stats.disconnects ?? 0;
  latency.textContent = stats.lastLatencyMs == null ? '--' : `${stats.lastLatencyMs} ms`;
  lastDisconnectAt.textContent = stats.lastDisconnectAt ? timeLabel(stats.lastDisconnectAt) : '--';
  lastDowntime.textContent = stats.lastDowntimeMs ? `${Math.round(stats.lastDowntimeMs / 1000)}s` : '--';
  lastDisconnectReason.textContent = stats.lastDisconnectReason || 'Sin eventos';
}

function clampCounterValue(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(100, Math.max(1, Math.round(numericValue)));
}

function setCounterValue(value) {
  counterValue.value = clampCounterValue(value);
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

writeCounterButton.addEventListener('click', () => {
  runAction(async () => {
    setCounterValue(counterValue.value);
    const request = getCounterRequest();
    const result = await window.plcApi.writeCounter(request);
    lastCounterValue.textContent = result.value;
  });
});

incrementCounterButton.addEventListener('click', () => {
  setCounterValue(Number(counterValue.value) + 1);
});

decrementCounterButton.addEventListener('click', () => {
  setCounterValue(Number(counterValue.value) - 1);
});

counterValue.addEventListener('change', () => {
  setCounterValue(counterValue.value);
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
  setStatusTiming(status);
  renderStats(status.stats);
  if (!status.connected && status.outageSeconds && status.stats?.lastDisconnectAt) {
    lastDowntime.textContent = `${status.outageSeconds}s actual`;
  }
  setControls();
});

window.plcApi.on('plc:log', appendLog);
window.plcApi.on('plc:data', (entry) => {
  appendData(entry);
  renderStats(entry.stats);
});

window.plcApi.getStatus()
  .then((status) => {
    connected = Boolean(status.connected);
    setStatus(connected ? 'connected' : 'disconnected');
    setStatusTiming(status);
    renderStats(status.stats);
    if (!status.connected && status.outageSeconds && status.stats?.lastDisconnectAt) {
      lastDowntime.textContent = `${status.outageSeconds}s actual`;
    }
    setControls();
  })
  .catch((error) => {
    appendLog({
      level: 'error',
      message: error.message || 'No se pudo leer el estado inicial.',
      at: new Date().toISOString()
    });
  });
