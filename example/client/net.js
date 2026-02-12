import { INPUT_MOVE, INPUT_INTERACT } from './constants.js';
import { decodeFullState, applyDelta } from './protocol.js';

export function connect(state) {
  const ws = new WebSocket('ws://localhost:9001');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => { state.hud.textContent = 'Connected'; };
  ws.onclose = () => {
    state.hud.textContent = 'Disconnected — refreshing...';
    setTimeout(() => location.reload(), 2000);
  };

  ws.onmessage = (e) => {
    const buf = e.data;
    const type = new Uint8Array(buf)[0];

    if (type === 0xFE) { // tile map
      const size = new Uint8Array(buf)[1];
      state.tileMap = new Uint8Array(buf, 2, size * size);
    } else if (type === 0xFD) { // player id
      state.myNetId = new DataView(buf).getUint16(1, true);
    } else if (type === 0x01) { // full state
      state.entities = decodeFullState(buf);
    } else if (type === 0x02) { // delta
      applyDelta(buf, state.entities);
    }
  };
}

export function sendMove(state, tx, ty) {
  const { ws } = state;
  if (!ws || ws.readyState !== 1) return;
  const buf = new ArrayBuffer(5);
  const v = new DataView(buf);
  v.setUint8(0, INPUT_MOVE);
  v.setInt16(1, tx, true);
  v.setInt16(3, ty, true);
  ws.send(buf);
}

export function sendInteract(state, tx, ty, action) {
  const { ws } = state;
  if (!ws || ws.readyState !== 1) return;
  const buf = new ArrayBuffer(6);
  const v = new DataView(buf);
  v.setUint8(0, INPUT_INTERACT);
  v.setInt16(1, tx, true);
  v.setInt16(3, ty, true);
  v.setUint8(5, action);
  ws.send(buf);
}
