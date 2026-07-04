const { contextBridge, ipcRenderer } = require('electron');

const validEvents = new Set(['plc:status', 'plc:log', 'plc:data']);

contextBridge.exposeInMainWorld('plcApi', {
  connect: (config) => ipcRenderer.invoke('plc:connect', config),
  disconnect: () => ipcRenderer.invoke('plc:disconnect'),
  detectMac: (request) => ipcRenderer.invoke('plc:detectMac', request),
  writeCounter: (request) => ipcRenderer.invoke('plc:writeCounter', request),
  getStatus: () => ipcRenderer.invoke('plc:getStatus'),
  on: (eventName, callback) => {
    if (!validEvents.has(eventName)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(eventName, listener);
    return () => ipcRenderer.removeListener(eventName, listener);
  }
});
