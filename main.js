const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');

let mainWindow;
let socket = null;
let currentConfig = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let statusTicker = null;
let heartbeatInFlight = false;
let connected = false;
let lastSendAt = 0;
let modbusTransactionId = 1;
let connectionState = 'disconnected';
let stateChangedAt = Date.now();
let connectedAt = null;
let outageStartedAt = null;
let lastSocketError = null;

const stats = {
  sent: 0,
  received: 0,
  disconnects: 0,
  errors: 0,
  reconnects: 0,
  lastLatencyMs: null,
  lastDisconnectAt: null,
  lastDisconnectReason: '',
  lastDowntimeMs: 0,
  lastReconnectAt: null
};

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const opensDevTools =
      input.key === 'F12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'i');

    if (opensDevTools) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.loadFile('panel.html').catch((error) => {
    console.error('No se pudo cargar panel.html:', error);
  });
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function log(message, level = 'info') {
  sendToRenderer('plc:log', {
    level,
    message,
    at: new Date().toISOString()
  });
}

function publishStatus(state, extra = {}) {
  if (state && state !== connectionState) {
    connectionState = state;
    stateChangedAt = Date.now();
  }

  const now = Date.now();
  sendToRenderer('plc:status', {
    state: connectionState,
    connected,
    stateSeconds: Math.max(0, Math.floor((now - stateChangedAt) / 1000)),
    connectedSeconds: connectedAt ? Math.max(0, Math.floor((now - connectedAt) / 1000)) : 0,
    outageSeconds: outageStartedAt ? Math.max(0, Math.floor((now - outageStartedAt) / 1000)) : 0,
    stats: { ...stats },
    config: currentConfig,
    ...extra
  });
}

function describeConnectionError(error, fallback = 'Conexion perdida') {
  const code = error?.code || '';
  const message = error?.message || '';

  if (message.includes('Heartbeat')) {
    return 'Timeout de monitoreo: el PLC dejo de aceptar/verificar conexion.';
  }

  if (code === 'ECONNREFUSED') {
    return 'Conexion rechazada: el PLC o puerto Modbus 502 no esta aceptando conexiones.';
  }

  if (code === 'ETIMEDOUT') {
    return 'Timeout de red: el PLC no respondio dentro del tiempo configurado.';
  }

  if (code === 'ECONNRESET') {
    return 'Conexion reiniciada: el PLC o la red cerraron la conexion abruptamente.';
  }

  if (code === 'EHOSTUNREACH') {
    return 'Host inaccesible: no hay ruta hacia la IP del PLC.';
  }

  if (code === 'ENETUNREACH') {
    return 'Red inaccesible: la PC perdio acceso a la red del PLC.';
  }

  if (code === 'EPIPE') {
    return 'Canal cerrado: se intento enviar cuando la conexion ya estaba cerrada.';
  }

  return message ? `${fallback}: ${message}` : fallback;
}

function rememberDisconnect(reason) {
  outageStartedAt = Date.now();
  stats.lastDisconnectAt = new Date(outageStartedAt).toISOString();
  stats.lastDisconnectReason = reason;
}

function rememberReconnect() {
  const now = Date.now();
  stats.lastReconnectAt = new Date(now).toISOString();

  if (outageStartedAt) {
    stats.lastDowntimeMs = now - outageStartedAt;
    log(`PLC reconectado. Tiempo fuera: ${Math.round(stats.lastDowntimeMs / 1000)}s.`, 'success');
  }

  outageStartedAt = null;
}

function payloadToBuffer(payload, mode) {
  if (mode === 'hex') {
    const normalized = payload.replace(/[\s,:-]/g, '');
    if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
      throw new Error('HEX invalido. Usa pares como 01 03 00 00.');
    }
    return Buffer.from(normalized, 'hex');
  }

  return Buffer.from(payload, 'utf8');
}

function closeSocket(countDisconnect = false, reason = 'Conexion cerrada') {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();

  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }

  if (connected && countDisconnect) {
    stats.disconnects += 1;
    rememberDisconnect(reason);
  }

  connected = false;
  connectedAt = null;
}

function scheduleReconnect() {
  if (!currentConfig || !currentConfig.autoReconnect || reconnectTimer || connected) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    stats.reconnects += 1;
    log('Intentando reconectar...');
    connectToPlc(currentConfig, true);
  }, Number(currentConfig.reconnectMs) || 2000);
}

function startStatusTicker() {
  if (statusTicker) return;

  statusTicker = setInterval(() => {
    publishStatus(connectionState);
  }, 1000);
}

function stopStatusTicker() {
  if (!statusTicker) return;
  clearInterval(statusTicker);
  statusTicker = null;
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatInFlight = false;
}

function probeTcpConnection(config) {
  return new Promise((resolve, reject) => {
    const host = String(config.host || '').trim();
    const port = Number(config.port || 502);
    const timeoutMs = Math.min(Number(config.timeoutMs) || 3000, 3000);
    const probeSocket = new net.Socket();
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      probeSocket.removeAllListeners();
      probeSocket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    probeSocket.setTimeout(timeoutMs);
    probeSocket.connect(port, host, () => finish());
    probeSocket.on('timeout', () => finish(new Error('Heartbeat sin respuesta.')));
    probeSocket.on('error', finish);
  });
}

function startHeartbeat() {
  stopHeartbeat();

  heartbeatTimer = setInterval(() => {
    if (!currentConfig || !connected || heartbeatInFlight) return;

    heartbeatInFlight = true;
    probeTcpConnection(currentConfig)
      .then(() => {
        heartbeatInFlight = false;
        publishStatus('connected');
      })
      .catch((error) => {
        heartbeatInFlight = false;
        stats.errors += 1;
        const reason = describeConnectionError(error, 'Monitoreo fallido');
        log(`PLC perdido: ${reason}`, 'error');
        closeSocket(true, reason);
        publishStatus('disconnected', { error: reason });
        scheduleReconnect();
      });
  }, 3000);
}

function connectToPlc(config, isReconnect = false) {
  closeSocket(false);
  currentConfig = config;
  connected = false;

  const host = String(config.host || '').trim();
  const port = Number(config.port);
  const timeoutMs = Number(config.timeoutMs) || 3000;

  if (!host) throw new Error('IP requerida.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto invalido.');

  socket = new net.Socket();
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);
  socket.setTimeout(timeoutMs);

  publishStatus(isReconnect ? 'reconnecting' : 'connecting');
  startStatusTicker();
  log(`${isReconnect ? 'Reconectando' : 'Conectando'} a ${host}:${port}...`);
  lastSocketError = null;

  socket.connect(port, host, () => {
    connected = true;
    connectedAt = Date.now();
    socket.setTimeout(0);
    rememberReconnect();
    log(`Conexion establecida con ${host}:${port}.`, 'success');
    publishStatus('connected');
    startHeartbeat();
  });

  socket.on('data', (data) => {
    stats.received += 1;
    if (lastSendAt) {
      stats.lastLatencyMs = Date.now() - lastSendAt;
    }

    sendToRenderer('plc:data', {
      text: data.toString('utf8'),
      hex: data.toString('hex').match(/.{1,2}/g)?.join(' ') || '',
      bytes: data.length,
      at: new Date().toISOString(),
      stats: { ...stats }
    });
    publishStatus('connected');
  });

  socket.on('timeout', () => {
    stats.errors += 1;
    const reason = `Timeout inicial: no se pudo establecer conexion en ${timeoutMs} ms.`;
    lastSocketError = reason;
    log(reason, 'warn');
    closeSocket(true, reason);
    publishStatus('timeout', { error: reason });
    scheduleReconnect();
  });

  socket.on('error', (error) => {
    stats.errors += 1;
    lastSocketError = describeConnectionError(error, 'Error de socket');
    log(lastSocketError, 'error');
    publishStatus('error', { error: lastSocketError });
  });

  socket.on('close', (hadError) => {
    const wasConnected = connected;
    connected = false;
    socket = null;

    if (wasConnected) {
      const reason = lastSocketError || (hadError ? 'Conexion cerrada con error por el PLC o la red.' : 'Conexion cerrada por el equipo remoto.');
      stats.disconnects += 1;
      rememberDisconnect(reason);
      log(reason, hadError ? 'error' : 'warn');
    }

    connectedAt = null;
    lastSocketError = null;
    publishStatus('disconnected');
    scheduleReconnect();
  });
}

function sendPayload(payload, mode) {
  if (!socket || !connected) throw new Error('No hay conexion activa.');

  const buffer = payloadToBuffer(String(payload ?? ''), mode);
  if (buffer.length === 0) throw new Error('El mensaje esta vacio.');

  lastSendAt = Date.now();
  socket.write(buffer);
  stats.sent += 1;
  publishStatus('connected');

  return {
    bytes: buffer.length,
    hex: buffer.toString('hex').match(/.{1,2}/g)?.join(' ') || ''
  };
}

function normalizeModbusRegister(register) {
  const numericRegister = Number(register);

  if (!Number.isInteger(numericRegister)) {
    throw new Error('Registro Modbus invalido.');
  }

  const address = numericRegister >= 400001 ? numericRegister - 400001 : numericRegister;

  if (address < 0 || address > 65535) {
    throw new Error('Registro fuera de rango. Usa 400001 para DS1 o una direccion 0-65535.');
  }

  return address;
}

function buildWriteSingleRegisterRequest({ unitId, register, value }) {
  const transactionId = modbusTransactionId;
  modbusTransactionId = modbusTransactionId >= 65535 ? 1 : modbusTransactionId + 1;

  const address = normalizeModbusRegister(register);
  const request = Buffer.alloc(12);

  request.writeUInt16BE(transactionId, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt16BE(6, 4);
  request.writeUInt8(unitId, 6);
  request.writeUInt8(6, 7);
  request.writeUInt16BE(address, 8);
  request.writeUInt16BE(value, 10);

  return { request, transactionId, address };
}

function parseModbusWriteResponse(response, { transactionId, address, value }) {
  if (response.length < 9) {
    throw new Error('Respuesta Modbus incompleta.');
  }

  const responseTransactionId = response.readUInt16BE(0);
  const protocolId = response.readUInt16BE(2);
  const functionCode = response.readUInt8(7);

  if (responseTransactionId !== transactionId) {
    throw new Error('Respuesta Modbus con transaction ID inesperado.');
  }

  if (protocolId !== 0) {
    throw new Error('Respuesta Modbus con protocol ID invalido.');
  }

  if (functionCode === 0x86) {
    const exceptionCode = response.readUInt8(8);
    throw new Error(`Excepcion Modbus ${exceptionCode}. Revisa registro y permisos del PLC.`);
  }

  if (functionCode !== 6 || response.length < 12) {
    throw new Error('El PLC no confirmo Write Single Register.');
  }

  const responseAddress = response.readUInt16BE(8);
  const responseValue = response.readUInt16BE(10);

  if (responseAddress !== address || responseValue !== value) {
    throw new Error('El PLC respondio con registro o valor diferente.');
  }
}

function writeModbusSingleRegister(options) {
  return new Promise((resolve, reject) => {
    const host = String(options.host || currentConfig?.host || '').trim();
    const port = Number(options.port || currentConfig?.port || 502);
    const timeoutMs = Number(options.timeoutMs || currentConfig?.timeoutMs || 3000);
    const unitId = Number(options.unitId || 1);
    const value = Number(options.value);

    if (!host) {
      reject(new Error('IP requerida para Modbus.'));
      return;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      reject(new Error('Puerto Modbus invalido.'));
      return;
    }

    if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) {
      reject(new Error('Unit ID Modbus invalido. Usa 1 normalmente.'));
      return;
    }

    if (!Number.isInteger(value) || value < 1 || value > 100) {
      reject(new Error('El contador debe estar entre 1 y 100.'));
      return;
    }

    let settled = false;
    const requestInfo = buildWriteSingleRegisterRequest({
      unitId,
      register: options.register,
      value
    });
    const modbusSocket = new net.Socket();
    const startedAt = Date.now();

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      modbusSocket.removeAllListeners();
      modbusSocket.destroy();

      if (error) {
        stats.errors += 1;
        publishStatus(connected ? 'connected' : 'error', { error: error.message });
        reject(error);
        return;
      }

      stats.sent += 1;
      stats.received += 1;
      stats.lastLatencyMs = Date.now() - startedAt;
      publishStatus(connected ? 'connected' : 'disconnected');
      resolve(result);
    };

    modbusSocket.setNoDelay(true);
    modbusSocket.setTimeout(timeoutMs);

    modbusSocket.connect(port, host, () => {
      modbusSocket.write(requestInfo.request);
    });

    modbusSocket.on('data', (response) => {
      try {
        parseModbusWriteResponse(response, {
          transactionId: requestInfo.transactionId,
          address: requestInfo.address,
          value
        });

        finish(null, {
          ok: true,
          host,
          port,
          unitId,
          register: Number(options.register),
          address: requestInfo.address,
          value,
          bytes: requestInfo.request.length,
          requestHex: requestInfo.request.toString('hex').match(/.{1,2}/g)?.join(' ') || '',
          responseHex: response.toString('hex').match(/.{1,2}/g)?.join(' ') || ''
        });
      } catch (error) {
        finish(error);
      }
    });

    modbusSocket.on('timeout', () => {
      finish(new Error(`Timeout Modbus despues de ${timeoutMs} ms.`));
    });

    modbusSocket.on('error', (error) => {
      finish(error);
    });
  });
}

function runCommand(command, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: `${stdout || ''}\n${stderr || ''}`
      });
    });
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseMacFromArp(output, host) {
  const hostLinePattern = new RegExp(`${escapeRegExp(host)}\\s+(([0-9a-f]{2}[:-]){5}[0-9a-f]{2})`, 'i');
  const hostLineMatch = output.match(hostLinePattern);
  const looseMatch = output.match(/(([0-9a-f]{2}[:-]){5}[0-9a-f]{2})/i);
  const mac = hostLineMatch?.[1] || looseMatch?.[1] || '';

  return mac ? mac.toUpperCase().replace(/:/g, '-') : null;
}

function detectAdapterMedium(name) {
  const normalized = String(name || '').toLowerCase();

  if (normalized.includes('wi-fi') || normalized.includes('wifi') || normalized.includes('wireless') || normalized.includes('wlan')) {
    return 'wifi';
  }

  if (normalized.includes('ethernet') || normalized.includes('lan')) {
    return 'ethernet';
  }

  return 'unknown';
}

function getNetworkAdapters() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) => (addresses || [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => ({
        name,
        medium: detectAdapterMedium(name),
        address: address.address,
        mac: address.mac
      })));
}

async function detectMacAddress(host) {
  const target = String(host || '').trim();
  if (!target) throw new Error('IP requerida para detectar MAC.');

  if (process.platform === 'win32') {
    await runCommand('ping', ['-n', '1', '-w', '800', target], 1800);
    const arp = await runCommand('arp', ['-a', target], 1800);
    const mac = parseMacFromArp(arp.output, target);

    if (!mac) {
      throw new Error('No se encontro MAC. Verifica que el PLC este en la misma red local.');
    }

    return mac;
  }

  await runCommand('ping', ['-c', '1', '-W', '1', target], 1800);
  const arp = await runCommand('arp', ['-n', target], 1800);
  const mac = parseMacFromArp(arp.output, target);

  if (!mac) {
    throw new Error('No se encontro MAC. Verifica que el PLC este en la misma red local.');
  }

  return mac;
}

ipcMain.handle('plc:connect', (_event, config) => {
  connectToPlc(config);
  return { ok: true };
});

ipcMain.handle('plc:disconnect', () => {
  closeSocket(true);
  log('Conexion detenida por el usuario.');
  publishStatus('disconnected');
  return { ok: true };
});

ipcMain.handle('plc:detectMac', async (_event, request) => {
  const host = request?.host || currentConfig?.host;
  const mac = await detectMacAddress(host);
  log(`MAC detectada para ${host}: ${mac}.`, 'success');
  return { ok: true, mac };
});

ipcMain.handle('plc:writeCounter', async (_event, request) => {
  const result = await writeModbusSingleRegister(request);
  log(`Modbus DS1 actualizado: valor ${result.value} en registro ${result.register}.`, 'success');
  sendToRenderer('plc:data', {
    text: `Write Single Register OK: ${result.register} = ${result.value}`,
    hex: `TX ${result.requestHex} | RX ${result.responseHex}`,
    bytes: result.bytes,
    at: new Date().toISOString(),
    stats: { ...stats }
  });
  return result;
});

ipcMain.handle('plc:getStatus', () => ({
  connected,
  state: connectionState,
  stateSeconds: Math.max(0, Math.floor((Date.now() - stateChangedAt) / 1000)),
  connectedSeconds: connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0,
  stats: { ...stats },
  config: currentConfig
}));

ipcMain.handle('plc:getNetworkAdapters', () => getNetworkAdapters());

app.whenReady()
  .then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    console.error('No se pudo iniciar Electron:', error);
  });

app.on('window-all-closed', () => {
  closeSocket(false);
  stopStatusTicker();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
