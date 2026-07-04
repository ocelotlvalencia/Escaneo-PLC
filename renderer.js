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
const startTimedTestButton = document.querySelector('#startTimedTestButton');
const stopTimedTestButton = document.querySelector('#stopTimedTestButton');
const counterValue = document.querySelector('#counterValue');
const modbusRegister = document.querySelector('#modbusRegister');
const unitId = document.querySelector('#unitId');
const lastCounterValue = document.querySelector('#lastCounterValue');
const lastDisconnectAt = document.querySelector('#lastDisconnectAt');
const lastDowntime = document.querySelector('#lastDowntime');
const lastDisconnectReason = document.querySelector('#lastDisconnectReason');
const testDuration = document.querySelector('#testDuration');
const testMedium = document.querySelector('#testMedium');
const testAdapter = document.querySelector('#testAdapter');
const testRemaining = document.querySelector('#testRemaining');
const testStartedAt = document.querySelector('#testStartedAt');
const testDisconnects = document.querySelector('#testDisconnects');
const logView = document.querySelector('#logView');
const dataView = document.querySelector('#dataView');
const sentCount = document.querySelector('#sentCount');
const receivedCount = document.querySelector('#receivedCount');
const disconnectCount = document.querySelector('#disconnectCount');
const latency = document.querySelector('#latency');
const statusSeconds = document.querySelector('#statusSeconds');
const macAddress = document.querySelector('#macAddress');

let connected = false;
let latestStats = {};
let timedTestTimer = null;
let timedTestEndsAt = 0;
let timedTestDisconnectBaseline = 0;
let networkAdapters = [];

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
  startTimedTestButton.disabled = !connected || Boolean(timedTestTimer);
  stopTimedTestButton.disabled = !timedTestTimer;
}

function renderStats(stats = {}) {
  latestStats = stats;
  sentCount.textContent = stats.sent ?? 0;
  receivedCount.textContent = stats.received ?? 0;
  disconnectCount.textContent = stats.disconnects ?? 0;
  latency.textContent = stats.lastLatencyMs == null ? '--' : `${stats.lastLatencyMs} ms`;
  lastDisconnectAt.textContent = stats.lastDisconnectAt ? timeLabel(stats.lastDisconnectAt) : '--';
  lastDowntime.textContent = stats.lastDowntimeMs ? `${Math.round(stats.lastDowntimeMs / 1000)}s` : '--';
  lastDisconnectReason.textContent = stats.lastDisconnectReason || 'Sin eventos';
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function mediumLabel(value) {
  return value === 'wifi' ? 'WiFi' : 'Ethernet';
}

function getSelectedAdapter() {
  const selectedMedium = testMedium.value;
  return networkAdapters.find((adapter) => adapter.medium === selectedMedium)
    || networkAdapters.find((adapter) => adapter.medium === 'unknown')
    || networkAdapters[0];
}

function renderSelectedAdapter() {
  const adapter = getSelectedAdapter();

  if (!adapter) {
    testAdapter.textContent = 'No detectada';
    return;
  }

  testAdapter.textContent = `${adapter.address} (${adapter.name})`;
}

async function refreshNetworkAdapters() {
  try {
    networkAdapters = await window.plcApi.getNetworkAdapters();
    renderSelectedAdapter();
  } catch (error) {
    networkAdapters = [];
    testAdapter.textContent = 'No detectada';
    appendLog({
      level: 'warn',
      message: error.message || 'No se pudieron leer las redes de la PC.',
      at: new Date().toISOString()
    });
  }
}

function updateTimedTest() {
  if (!timedTestTimer) return;

  const remainingSeconds = Math.ceil((timedTestEndsAt - Date.now()) / 1000);
  const disconnects = Math.max(0, (latestStats.disconnects || 0) - timedTestDisconnectBaseline);

  testRemaining.textContent = formatDuration(remainingSeconds);
  testDisconnects.textContent = disconnects;

  if (remainingSeconds <= 0) {
    stopTimedTest('Prueba finalizada por tiempo.');
  }
}

function startTimedTest() {
  const durationSeconds = Number(testDuration.value);
  const adapter = getSelectedAdapter();
  const selectedMedium = mediumLabel(testMedium.value);

  timedTestDisconnectBaseline = latestStats.disconnects || 0;
  timedTestEndsAt = Date.now() + durationSeconds * 1000;
  testStartedAt.textContent = timeLabel(new Date().toISOString());
  testDisconnects.textContent = '0';

  if (timedTestTimer) {
    clearInterval(timedTestTimer);
  }

  timedTestTimer = setInterval(updateTimedTest, 1000);
  appendLog({
    level: 'info',
    message: `Prueba por tiempo iniciada: ${Math.round(durationSeconds / 60)} min por ${selectedMedium}${adapter ? ` (${adapter.address}, ${adapter.name})` : ''}.`,
    at: new Date().toISOString()
  });
  updateTimedTest();
  setControls();
}

function stopTimedTest(message = 'Prueba por tiempo detenida.') {
  if (!timedTestTimer) return;

  clearInterval(timedTestTimer);
  timedTestTimer = null;

  const disconnects = Math.max(0, (latestStats.disconnects || 0) - timedTestDisconnectBaseline);
  testRemaining.textContent = 'Sin prueba';
  testDisconnects.textContent = disconnects;
  appendLog({
    level: disconnects > 0 ? 'warn' : 'success',
    message: `${message} Desconexiones durante prueba: ${disconnects}.`,
    at: new Date().toISOString()
  });
  setControls();
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

startTimedTestButton.addEventListener('click', () => {
  runAction(async () => startTimedTest());
});

stopTimedTestButton.addEventListener('click', () => {
  stopTimedTest();
});

testMedium.addEventListener('change', renderSelectedAdapter);

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

refreshNetworkAdapters();
