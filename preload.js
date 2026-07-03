const { contextBridge, ipcRenderer } = require('electron');

const validEvents = new Set(['plc:status', 'plc:log', 'plc:data', 'plc:loop']);

contextBridge.exposeInMainWorld('plcApi', {
  connect: (config) => ipcRenderer.invoke('plc:connect', config),
  disconnect: () => ipcRenderer.invoke('plc:disconnect'),
  send: (request) => ipcRenderer.invoke('plc:send', request),
  detectMac: (request) => ipcRenderer.invoke('plc:detectMac', request),
  startLoop: (request) => ipcRenderer.invoke('plc:startLoop', request),
  stopLoop: () => ipcRenderer.invoke('plc:stopLoop'),
  getStatus: () => ipcRenderer.invoke('plc:getStatus'),
  on: (eventName, callback) => {
    if (!validEvents.has(eventName)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(eventName, listener);
    return () => ipcRenderer.removeListener(eventName, listener);
  }
});
